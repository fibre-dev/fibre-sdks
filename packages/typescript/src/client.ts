import { ConnectionError, FibreError, TimeoutError, errorFromAnswer, type ErrorBody } from "./errors.js";
import { VERSION } from "./version.js";

export interface FibreOptions {
  /** An API key. Defaults to `FIBRE_API_KEY`, or `FIBRE_TOKEN`. */
  apiKey?: string;
  /** The API's address. Defaults to `FIBRE_API_URL`, or https://api.fibre.dev. */
  baseUrl?: string;
  /** Seconds before a request is given up (60). Streams of output are not limited by it. */
  timeout?: number;
  /** How many times a request that failed to connect, or met a busy or unavailable API, is tried again (2). */
  maxRetries?: number;
  /** A `fetch` to use instead of the global one (tests, proxies). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  body?: unknown;
  /** Bytes or text sent as the body, as they are. */
  raw?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Seconds; overrides the client's. `0` means no limit (for streams). */
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Safe to send again after a failure: `true` on dropped connections and 429 / 502 / 503 / 504; `"transient"` on
   * dropped connections and 429 / 502 / 504 only. Reads, PUT and DELETE default to `true`, other requests to `false`.
   */
  retry?: boolean | "transient";
}

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env?.[name] : undefined) || undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const TRANSIENT_STATUSES = new Set([429, 502, 504]);

export class Fibre {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: FibreOptions = {}) {
    this.#apiKey = options.apiKey ?? env("FIBRE_API_KEY") ?? env("FIBRE_TOKEN");
    this.baseUrl = (options.baseUrl ?? env("FIBRE_API_URL") ?? "https://api.fibre.dev").replace(/\/+$/, "");
    this.timeout = options.timeout ?? 60;
    this.maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The URL of an API path, with its query. */
  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** A request's raw answer: errors become `FibreError`s, failures to connect are tried again when safe. */
  async fetch(method: string, path: string, o: RequestOptions = {}): Promise<Response> {
    if (!this.#apiKey) {
      throw new FibreError("No API key: pass apiKey, or set FIBRE_API_KEY", { code: "missing_api_key" });
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      "user-agent": `fibre-sdk-typescript/${VERSION}`,
      ...o.headers,
    };
    let body: BodyInit | undefined = o.raw;
    if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    const canRetry = o.retry ?? ["GET", "HEAD", "PUT", "DELETE"].includes(method);
    const seconds = o.timeout ?? this.timeout;

    for (let attempt = 0; ; attempt++) {
      const limit = seconds > 0 ? AbortSignal.timeout(seconds * 1000) : undefined;
      const signal = limit && o.signal ? AbortSignal.any([limit, o.signal]) : (limit ?? o.signal);
      let res: Response;
      try {
        res = await this.#fetch(this.url(path, o.query), { method, headers, body, signal });
      } catch (e) {
        if (o.signal?.aborted) throw e;
        if (limit?.aborted) throw new TimeoutError(`${method} ${path}: no answer within ${seconds} s`, { code: "timeout" });
        if (canRetry && attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ConnectionError(`${method} ${path}: ${(e as Error).message}`, { code: "connection_failed" });
      }
      if (res.ok) return res;
      const answer = await readError(res);
      const statuses = canRetry === "transient" ? TRANSIENT_STATUSES : RETRY_STATUSES;
      if (canRetry && attempt < this.maxRetries && statuses.has(res.status)) {
        const wait = typeof answer.retry_after_ms === "number" ? answer.retry_after_ms : backoff(attempt);
        if (wait <= 60_000) {
          await sleep(wait);
          continue;
        }
      }
      throw errorFromAnswer(res.status, answer);
    }
  }

  /** A request whose answer is JSON. */
  async json<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const res = await this.fetch(method, path, o);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Half a second, doubling, with jitter, at most 8 seconds. */
function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

async function readError(res: Response): Promise<ErrorBody> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as ErrorBody;
  } catch {
    return { error: text.slice(0, 300) || res.statusText };
  }
}

let shared: Fibre | undefined;

/** The client `Sandbox.create()` and friends use: from the environment, made on first use. */
export function defaultClient(): Fibre {
  shared ??= new Fibre();
  return shared;
}

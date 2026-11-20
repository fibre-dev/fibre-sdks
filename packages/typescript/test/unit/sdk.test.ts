import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Fibre, FibreError, NotFoundError, RateLimitError, Sandbox, ServerError, TimeoutError, VERSION } from "../../src/index.js";

// a fake fetch: answers in order, records every request
type Answer = { status?: number; json?: unknown; text?: string; chunks?: string[] } | Error;
function fake(answers: Answer[]) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn: typeof fetch = (async (input: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", url: new URL(input), headers: init.headers as Record<string, string>, body: init.body });
    const a = answers.shift();
    if (!a) throw new Error(`no answer left for ${init.method} ${input}`);
    if (a instanceof Error) throw a;
    if (a.chunks) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({ start(c) { for (const ch of a.chunks!) c.enqueue(enc.encode(ch)); c.close(); } });
      return new Response(stream, { status: a.status ?? 200, headers: { "content-type": "application/x-ndjson" } });
    }
    const body = a.text ?? (a.json === undefined ? "" : JSON.stringify(a.json));
    return new Response(body, { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, client: (o = {}) => new Fibre({ apiKey: "k", baseUrl: "https://api.test", fetch: fetchFn, maxRetries: 2, ...o }) };
}

const SBX = { id: "sbx-0123456789", status: "running", runtime: "standard", url: "https://x.test", hostname: "x.test", labels: {}, expires_at: "2026-11-20T00:00:00Z", idle_timeout_sec: 300 };
const CMD = { command_id: "c1", command: ["sh", "-c", "x"], status: "running", exit_code: null, started_at: "t", ended_at: null, stdout_bytes: 0, stderr_bytes: 0 };

describe("client", () => {
  it("the version matches package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  });

  it("takes the key from FIBRE_API_KEY, then FIBRE_TOKEN, and the address from FIBRE_API_URL", () => {
    const saved = { ...process.env };
    try {
      delete process.env.FIBRE_API_KEY;
      process.env.FIBRE_TOKEN = "t";
      process.env.FIBRE_API_URL = "https://elsewhere.test/";
      const c = new Fibre();
      expect(c.baseUrl).toBe("https://elsewhere.test");
      expect(c.url("/v1/x", { a: 1, b: undefined })).toBe("https://elsewhere.test/v1/x?a=1");
    } finally {
      process.env = saved;
    }
  });

  it("refuses to send a request with no key", async () => {
    const saved = { ...process.env };
    delete process.env.FIBRE_API_KEY;
    delete process.env.FIBRE_TOKEN;
    try {
      await expect(new Fibre({ fetch: (() => {}) as never }).json("GET", "/v1/sandboxes")).rejects.toMatchObject({ code: "missing_api_key" });
    } finally {
      process.env = saved;
    }
  });

  it("sends the key and a user agent with the version", async () => {
    const f = fake([{ json: SBX }]);
    await Sandbox.get("sbx-0123456789", f.client());
    expect(f.calls[0].headers.authorization).toBe("Bearer k");
    expect(f.calls[0].headers["user-agent"]).toBe(`fibre-sdk-typescript/${VERSION}`);
  });

  it("turns error answers into typed errors with code, request id and docs url", async () => {
    const f = fake([{ status: 404, json: { error: "No sandbox", code: "sandbox_not_found", request_id: "req_1", docs_url: "https://d/#sandbox_not_found" } }]);
    const e = await Sandbox.get("sbx-0000000000", f.client()).catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e).toBeInstanceOf(FibreError);
    expect(e).toMatchObject({ status: 404, code: "sandbox_not_found", requestId: "req_1", docsUrl: "https://d/#sandbox_not_found", message: "No sandbox" });
  });

  it("retries a read on 503 and a dropped connection, and reports retry_after on 429", async () => {
    const f = fake([{ status: 503, json: { error: "busy", code: "x" } }, new TypeError("socket hang up"), { json: SBX }]);
    expect((await Sandbox.get("sbx-0123456789", f.client())).id).toBe("sbx-0123456789");
    expect(f.calls).toHaveLength(3);
    const g = fake([{ status: 429, json: { error: "slow down", code: "rate_limited", retry_after_ms: 120000 } }]);
    const e = await Sandbox.get("sbx-0123456789", g.client()).catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfter).toBe(120);
    expect(g.calls).toHaveLength(1); // a wait over a minute is the caller's to decide
  });

  it("does not retry a command start; retries a create with the same idempotency key", async () => {
    const f = fake([{ status: 502, json: { error: "x", code: "engine_unreachable" } }]);
    const sbx = new (Sandbox as any)(f.client(), SBX) as Sandbox;
    await expect(sbx.spawn("true")).rejects.toBeInstanceOf(ServerError);
    expect(f.calls).toHaveLength(1);
    const g = fake([{ status: 502, json: { error: "x", code: "engine_unreachable" } }, { status: 201, json: SBX }]);
    await Sandbox.create({ labels: { a: "b" }, idleTimeout: 60 }, g.client());
    expect(g.calls).toHaveLength(2);
    expect(g.calls[0].headers["idempotency-key"]).toBeTruthy();
    expect(g.calls[1].headers["idempotency-key"]).toBe(g.calls[0].headers["idempotency-key"]);
    expect(JSON.parse(g.calls[0].body as string)).toMatchObject({ labels: { a: "b" }, idle_timeout_sec: 60 });
  });

  it("does not retry a create that failed with 503, and puts the API's detail in the message", async () => {
    const f = fake([{ status: 503, json: { error: "No capacity available", code: "engine_error", message: "port 8000 not ready after 120s" } }]);
    const e = await Sandbox.create({}, f.client()).catch((x) => x);
    expect(e).toBeInstanceOf(ServerError);
    expect(e.message).toBe("No capacity available: port 8000 not ready after 120s");
    expect(f.calls).toHaveLength(1);
  });
});

describe("commands", () => {
  it("run starts a command (a string through sh -c) and collects its output from the stream, split anywhere", async () => {
    const f = fake([
      { status: 201, json: CMD },
      { chunks: ['{"stream":"stdout","data":"hel', 'lo\\n","offset":0}\n{"stream":"stderr","data":"warn\\n","offset":0}\n', '{"event":"end","exit_code":3,"status":"exited"}\n'] },
    ]);
    const sbx = new (Sandbox as any)(f.client(), SBX) as Sandbox;
    const r = await sbx.run("echo hello; exit 3");
    expect(r).toEqual({ exitCode: 3, status: "exited", stdout: "hello\n", stderr: "warn\n" });
    expect(f.calls[0].url.pathname).toBe("/v1/sandboxes/sbx-0123456789/commands");
    expect(JSON.parse(f.calls[0].body as string).command).toEqual(["sh", "-c", "echo hello; exit 3"]);
    expect(f.calls[1].url.searchParams.get("follow")).toBe("1");
  });

  it("output picks up where it left off when the stream drops before the end", async () => {
    const f = fake([
      { status: 201, json: CMD },
      { chunks: ['{"stream":"stdout","data":"ab","offset":0}\n'] },
      { json: CMD },
      { chunks: ['{"stream":"stdout","data":"bc","offset":1}\n{"event":"end","exit_code":0,"status":"exited"}\n'] },
    ]);
    const sbx = new (Sandbox as any)(f.client(), SBX) as Sandbox;
    const r = await sbx.run(["cat", "x"]);
    expect(r.stdout).toBe("abc");
    expect(f.calls[3].url.searchParams.get("stdout_offset")).toBe("2");
  });

  it("a timeout stops the command and throws", async () => {
    const never = { status: 200, chunks: [] as string[] };
    const slow = (async (input: string, init: RequestInit = {}) => {
      if (input.includes("/logs")) return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      if (input.endsWith("/kill")) return new Response(JSON.stringify({ ...CMD, status: "killed" }), { status: 200 });
      return new Response(JSON.stringify(CMD), { status: 201 });
    }) as unknown as typeof fetch;
    void never;
    const sbx = new (Sandbox as any)(new Fibre({ apiKey: "k", baseUrl: "https://api.test", fetch: slow }), SBX) as Sandbox;
    await expect(sbx.run("sleep 100", { timeout: 0.2 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("sandboxes and files", () => {
  it("list follows the pages and passes labels", async () => {
    const f = fake([{ json: { sandboxes: [SBX], next_cursor: "n1" } }, { json: { sandboxes: [{ ...SBX, id: "sbx-1111111111" }], next_cursor: null } }]);
    const ids: string[] = [];
    for await (const s of Sandbox.list({ labels: { team: "docs" } }, f.client())) ids.push(s.id);
    expect(ids).toEqual(["sbx-0123456789", "sbx-1111111111"]);
    expect(f.calls[0].url.searchParams.get("label.team")).toBe("docs");
    expect(f.calls[1].url.searchParams.get("cursor")).toBe("n1");
  });

  it("files.write sends the bytes as they are, to the path", async () => {
    const f = fake([{ json: { path: "/w/a.bin", size: 3, sha256: "h" } }]);
    const sbx = new (Sandbox as any)(f.client(), SBX) as Sandbox;
    await sbx.files.write("/w/a.bin", new Uint8Array([0, 1, 2]));
    expect(f.calls[0].method).toBe("PUT");
    expect(f.calls[0].url.searchParams.get("path")).toBe("/w/a.bin");
    expect(f.calls[0].body).toEqual(new Uint8Array([0, 1, 2]));
  });
});

import type { Fibre } from "./client.js";
import { TimeoutError } from "./errors.js";
import type { CommandData, CommandLogLine, CommandResult, OutputChunk } from "./types.js";

const utf8 = new TextEncoder();

/**
 * A command running in a sandbox, started with `sandbox.spawn()` or found again with `sandbox.command(id)`. Follow
 * its output with `output()`, wait for it with `wait()`, write to it, or stop it. A kept command (`keep: true`)
 * runs on its own: its status is `detached` and its output goes to the file named in `log`.
 */
export class Command {
  readonly id: string;
  #data: CommandData;
  readonly #client: Fibre;
  readonly #base: string;

  /** @internal */
  constructor(client: Fibre, sandboxId: string, data: CommandData) {
    this.#client = client;
    this.#data = data;
    this.id = data.command_id;
    this.#base = `/v1/sandboxes/${sandboxId}/commands/${encodeURIComponent(data.command_id)}`;
  }

  /** `running`, then `exited` or `killed`; `detached` for a kept command; `lost` if the sandbox lost track of it. */
  get status(): string {
    return this.#data.status;
  }
  get exitCode(): number | null {
    return this.#data.exit_code;
  }
  /** A kept command's process id in the sandbox. */
  get pid(): number | null {
    return this.#data.pid ?? null;
  }
  /** A kept command's output file in the sandbox (read it with `sandbox.files.read`). */
  get log(): string | null {
    return this.#data.log ?? null;
  }
  get data(): CommandData {
    return this.#data;
  }

  /** The command's current status, from the sandbox. */
  async refresh(): Promise<this> {
    this.#data = await this.#client.json<CommandData>("GET", this.#base);
    return this;
  }

  /**
   * The command's output as it is written, until it ends. Pass `follow: false` for what is there now. If the
   * connection drops, it picks up where it left off.
   */
  async *output(o: { follow?: boolean; signal?: AbortSignal } = {}): AsyncGenerator<OutputChunk, void, undefined> {
    const offsets = { stdout: 0, stderr: 0 };
    const follow = o.follow ?? true;
    for (let reconnects = 0; ; reconnects++) {
      const res = await this.#client.fetch("GET", `${this.#base}/logs`, {
        query: { follow: follow ? 1 : undefined, stdout_offset: offsets.stdout, stderr_offset: offsets.stderr },
        timeout: follow ? 0 : undefined,
        signal: o.signal,
      });
      let ended = false;
      for await (const line of ndjson(res)) {
        if ("event" in line && line.event === "end") {
          this.#data = { ...this.#data, status: line.status, exit_code: line.exit_code };
          ended = true;
          break;
        }
        if ("stream" in line) {
          const skip = Math.max(0, offsets[line.stream] - line.offset);
          const data = skip ? new TextDecoder().decode(utf8.encode(line.data).slice(skip)) : line.data;
          offsets[line.stream] = Math.max(offsets[line.stream], line.offset + utf8.encode(line.data).byteLength);
          if (data) yield { stream: line.stream, data };
        }
      }
      if (ended || !follow) return;
      // the stream closed before the end: the command may be over, or the connection dropped
      await this.refresh();
      if (this.status !== "running" || reconnects >= 5) return;
    }
  }

  /**
   * Wait for the command to end and return its result with all of its output. With `timeout` (seconds), a command
   * still running is stopped and a `TimeoutError` thrown. A kept command returns at once.
   */
  async wait(o: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (this.status === "detached") return { exitCode: null, status: "detached", stdout: "", stderr: "" };
    const out = { stdout: "", stderr: "" };
    const stop = o.timeout ? AbortSignal.timeout(o.timeout * 1000) : undefined;
    const signal = stop && o.signal ? AbortSignal.any([stop, o.signal]) : (stop ?? o.signal);
    try {
      for await (const chunk of this.output({ signal })) out[chunk.stream] += chunk.data;
    } catch (e) {
      if (stop?.aborted) {
        await this.kill().catch(() => {});
        throw new TimeoutError(`command ${this.id} still running after ${o.timeout} s; stopped`, { code: "command_timeout" });
      }
      throw e;
    }
    if (this.status === "running") await this.refresh();
    return { exitCode: this.exitCode, status: this.status, ...out };
  }

  /** Write to the command's standard input (start it with `stdin: true`). */
  async write(data: string | Uint8Array): Promise<void> {
    await this.#client.fetch("POST", `${this.#base}/stdin`, { raw: data as BodyInit, headers: { "content-type": "application/octet-stream" } });
  }

  /** Close the command's standard input, so it sees the end of its input. */
  async closeStdin(): Promise<void> {
    await this.#client.fetch("POST", `${this.#base}/stdin/close`);
  }

  /** Stop the command: `TERM`, then `KILL` after `grace` seconds (5); `signal: "KILL"` stops it at once. */
  async kill(o: { signal?: string; grace?: number } = {}): Promise<this> {
    this.#data = await this.#client.json<CommandData>("POST", `${this.#base}/kill`, { body: { signal: o.signal, grace_s: o.grace } });
    return this;
  }
}

/** The lines of an NDJSON answer, parsed. */
async function* ndjson(res: Response): AsyncGenerator<CommandLogLine, void, undefined> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as CommandLogLine;
    }
  }
  const rest = (buf + decoder.decode()).trim();
  if (rest) yield JSON.parse(rest) as CommandLogLine;
}

import { defaultClient, type Fibre } from "./client.js";
import { Command } from "./command.js";
import { Files } from "./files.js";
import { Template } from "./template.js";
import type { BrowserLinks, CommandData, CommandLine, CommandResult, DesktopLink, Need, Runtime, SandboxData, SavedImage, Size, TemplateData } from "./types.js";

export interface SandboxCreateOptions {
  /** The image to run. Left out: fibre's default image (a shell, Python, Node, git and a browser). */
  image?: string;
  /** small, default, large or xlarge. */
  size?: Size;
  /** `standard` for most work, `vm` for a full virtual machine with its own kernel. Left out, fibre picks. */
  runtime?: Runtime;
  /** What the sandbox needs: `docker`, `fuse`, `cgroups`, `loop`, `iptables` (these call for `vm`), `browser`, `desktop`. */
  needs?: Need[];
  /** `systemd` as the first process (`vm` only). */
  init?: "systemd";
  /** Environment variables for everything run in it. */
  env?: Record<string, string>;
  /** Your own labels, to find it again with `Sandbox.list({ labels })`. */
  labels?: Record<string, string>;
  /** Seconds without activity before it sleeps (300); `0` never sleeps. */
  idleTimeout?: number;
  /** Seconds before it is deleted (3600), 60 to 86400; extend it later with `update({ lifetime })`. */
  lifetime?: number;
  /** The port its `url` serves. */
  exposedPort?: number;
  /** Start from a template: a sandbox saved with its memory, already running. */
  template?: string;
  /** Which sites it may reach: `{ block: true }`, or `{ allow: ["example.com", …] }`. */
  network?: { block?: boolean; allow?: string[] };
  /** The command its image runs, instead of the image's own. */
  entrypoint?: string[];
  /**
   * When the answer comes: `process`, once it runs (the default with fibre's image, a template, `init` or a desktop);
   * `port`, once something listens on `exposedPort` (the default with an image of your own). Pass `process` for an
   * image that serves nothing.
   */
  ready?: "port" | "process";
  /** Seconds to wait for the answer (300): a first start of an image can take a while. */
  timeout?: number;
}

export interface SandboxListOptions {
  /** Only sandboxes with every one of these labels. */
  labels?: Record<string, string>;
  /** How many to fetch per page (50, at most 200). */
  pageSize?: number;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Keep it running on its own, across the sandbox's sleep: for dev servers, databases, daemons. */
  keep?: boolean;
  /** Open its standard input, to `write()` to it. */
  stdin?: boolean;
  /** Seconds after which the sandbox stops it. */
  timeoutSec?: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds; a command still running then is stopped and a `TimeoutError` thrown. No limit by default. */
  timeout?: number;
  signal?: AbortSignal;
}

const argv = (cmd: CommandLine): string[] => (typeof cmd === "string" ? ["sh", "-c", cmd] : cmd);

/**
 * A sandbox: an isolated Linux machine for code you do not want on your own. Create one, run commands in it, move
 * files in and out, and delete it when you are done. When nobody uses it, it sleeps with its memory and comes back
 * on the next call: every method works the same whether it is awake or asleep.
 */
export class Sandbox {
  readonly id: string;
  /** Its files: write, read, list, stat, remove. */
  readonly files: Files;
  #data: SandboxData;
  readonly #client: Fibre;

  /** @internal */
  constructor(client: Fibre, data: SandboxData) {
    this.#client = client;
    this.#data = data;
    this.id = data.id;
    this.files = new Files(client, data.id);
  }

  /** Create and start a sandbox; the answer comes once it is running. */
  static async create(o: SandboxCreateOptions = {}, client: Fibre = defaultClient()): Promise<Sandbox> {
    const body = {
      image: o.image,
      size: o.size,
      runtime: o.runtime,
      needs: o.needs,
      init: o.init,
      env_vars: o.env,
      labels: o.labels,
      idle_timeout_sec: o.idleTimeout,
      lifetime_sec: o.lifetime,
      exposed_port: o.exposedPort,
      template: o.template,
      network: o.network,
      entrypoint: o.entrypoint,
      ready: o.ready,
    };
    // the same key on a retry returns the first sandbox instead of making a second one. A 503 is not retried: it can
    // be a start that failed for good (a port that never opened), not a busy platform
    const data = await client.json<SandboxData>("POST", "/v1/sandboxes", {
      body,
      headers: { "idempotency-key": crypto.randomUUID() },
      retry: "transient",
      timeout: o.timeout ?? 300,
    });
    return new Sandbox(client, data);
  }

  /** A sandbox you created earlier, by its id, asleep or awake. */
  static async get(id: string, client: Fibre = defaultClient()): Promise<Sandbox> {
    return new Sandbox(client, await client.json<SandboxData>("GET", `/v1/sandboxes/${encodeURIComponent(id)}`));
  }

  /** Every sandbox of the account, newest first, optionally by labels; the pages are fetched as you go. */
  static async *list(o: SandboxListOptions = {}, client: Fibre = defaultClient()): AsyncGenerator<Sandbox, void, undefined> {
    let cursor: string | undefined;
    do {
      const query: Record<string, string | number | undefined> = { limit: o.pageSize, cursor };
      for (const [k, v] of Object.entries(o.labels ?? {})) query[`label.${k}`] = v;
      const page = await client.json<{ sandboxes: SandboxData[]; next_cursor: string | null }>("GET", "/v1/sandboxes", { query });
      for (const s of page.sandboxes) yield new Sandbox(client, s);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  /** `running` while awake, `standby` while it sleeps. */
  get status(): string {
    return this.#data.status;
  }
  get runtime(): Runtime {
    return this.#data.runtime as Runtime;
  }
  /** Why it runs on its runtime (`default`, `requested`, `needs:docker`, …), as the create answered. */
  get runtimeReason(): string | undefined {
    return this.#data.runtime_reason;
  }
  /** Its public https address: anyone who has it can open what the sandbox serves on its exposed port. */
  get url(): string {
    return this.#data.url;
  }
  get hostname(): string {
    return this.#data.hostname;
  }
  get labels(): Record<string, string> {
    return this.#data.labels;
  }
  /** When it will be deleted, unless its lifetime is extended. */
  get expiresAt(): Date {
    return new Date(this.#data.expires_at);
  }
  /** Seconds without activity before it sleeps. */
  get idleTimeout(): number {
    return this.#data.idle_timeout_sec;
  }
  /** Everything the API said about it. */
  get data(): SandboxData {
    return this.#data;
  }

  /** Its current state, from the API. */
  async refresh(): Promise<this> {
    this.#data = { ...this.#data, ...(await this.#client.json<SandboxData>("GET", `/v1/sandboxes/${this.id}`)) };
    return this;
  }

  /** Extend its lifetime (seconds, counted from now), change its idle timeout or its labels. */
  async update(o: { lifetime?: number; idleTimeout?: number; labels?: Record<string, string> }): Promise<this> {
    const body = { lifetime_sec: o.lifetime, idle_timeout_sec: o.idleTimeout, labels: o.labels };
    this.#data = { ...this.#data, ...(await this.#client.json<SandboxData>("PATCH", `/v1/sandboxes/${this.id}`, { body })) };
    return this;
  }

  /** Delete it, with everything in it. */
  async delete(): Promise<void> {
    await this.#client.fetch("DELETE", `/v1/sandboxes/${this.id}`);
  }

  /**
   * Run a command and wait for it: its exit code and all of its output. A string runs in `sh -c`; an array is the
   * program and its arguments. No time limit unless you give `timeout` (seconds). A non-zero exit code is a result,
   * not an error.
   */
  async run(cmd: CommandLine, o: RunOptions = {}): Promise<CommandResult> {
    const command = await this.spawn(cmd, { cwd: o.cwd, env: o.env });
    return command.wait({ timeout: o.timeout, signal: o.signal });
  }

  /**
   * Start a command in the background and get it at once: follow its `output()`, `wait()` for it, `write()` to it,
   * `kill()` it, or find it again later with `command(id)`. With `keep: true` it runs on its own and carries on
   * across the sandbox's sleep: start dev servers, databases and daemons this way. (On the `standard` runtime, a
   * program still running at a sleep is kept only if it was started with `keep`.)
   */
  async spawn(cmd: CommandLine, o: SpawnOptions = {}): Promise<Command> {
    const body = { command: argv(cmd), cwd: o.cwd, env: o.env, keep: o.keep, stdin: o.stdin, timeout_sec: o.timeoutSec };
    const data = await this.#client.json<CommandData>("POST", `/v1/sandboxes/${this.id}/commands`, { body });
    return new Command(this.#client, this.id, data);
  }

  /** A command started earlier, by its id (from this or another process). */
  async command(id: string): Promise<Command> {
    const data = await this.#client.json<CommandData>("GET", `/v1/sandboxes/${this.id}/commands/${encodeURIComponent(id)}`);
    return new Command(this.#client, this.id, data);
  }

  /**
   * Save it as a template, with its memory: sandboxes created from it start already running, as this one is now.
   * This sandbox keeps running. On the `vm` runtime, wait until its commands have ended first.
   */
  async snapshot(o: { name: string }): Promise<Template> {
    // the snapshot is taken while it runs; the answer comes once the template is ready
    const data = await this.#client.json<TemplateData>("POST", "/v1/templates", { body: { name: o.name, from: this.id }, timeout: 600 });
    return new Template(this.#client, data);
  }

  /**
   * Save its files as an image of your account (`standard` runtime): new sandboxes and services can run it with
   * `image`. Only what the sandbox changed is stored. Memory is not part of it; a template keeps memory.
   */
  async saveImage(): Promise<SavedImage> {
    const r = await this.#client.json<{ image: string; size_bytes: number; changes_bytes: number }>("POST", `/v1/sandboxes/${this.id}/snapshot`, { timeout: 600 });
    return { image: r.image, sizeBytes: r.size_bytes, changesBytes: r.changes_bytes };
  }

  /**
   * Links to its browser, starting it if needed: `cdpUrl` for your code, `liveViewUrl` to watch. They work for an
   * hour, or `ttl` seconds (60 to a day, never past the sandbox's lifetime). Treat `cdpUrl` as a password.
   */
  async browser(o: { ttl?: number } = {}): Promise<BrowserLinks> {
    const r = await this.#client.json<{ cdp_url: string; live_view_url: string; expires_at: string }>("POST", `/v1/sandboxes/${this.id}/browser`, {
      body: { ttl_sec: o.ttl },
      timeout: 120,
    });
    return { cdpUrl: r.cdp_url, liveViewUrl: r.live_view_url, expiresAt: new Date(r.expires_at) };
  }

  /** Revoke every link to its browser, close their connections and stop the browser. */
  async closeBrowser(): Promise<void> {
    await this.#client.fetch("DELETE", `/v1/sandboxes/${this.id}/browser`);
  }

  /** A single-use link to watch and use its desktop (a sandbox created with `needs: ["desktop"]`). */
  async desktop(): Promise<DesktopLink> {
    const r = await this.#client.json<{ url: string; expires_in: number }>("POST", `/v1/sandboxes/${this.id}/desktop`);
    return { url: r.url, expiresIn: r.expires_in };
  }

  /** The commands of its current awake period. */
  async commands(): Promise<Command[]> {
    const { commands } = await this.#client.json<{ commands: CommandData[] }>("GET", `/v1/sandboxes/${this.id}/commands`);
    return commands.map((c) => new Command(this.#client, this.id, c));
  }
}

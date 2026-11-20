import type { Fibre } from "./client.js";
import type { FileEntry } from "./types.js";

export type FileContent = string | Uint8Array | ArrayBuffer | Blob;

/**
 * The files of a sandbox (`sandbox.files`): write, read, list, inspect and remove. Any content, text or binary, as
 * large as the sandbox's free disk. Paths are absolute. A sleeping sandbox is woken first.
 */
export class Files {
  readonly #client: Fibre;
  readonly #base: string;

  /** @internal */
  constructor(client: Fibre, sandboxId: string) {
    this.#client = client;
    this.#base = `/v1/sandboxes/${sandboxId}/files`;
  }

  /** Write a file, creating the directories on the way; a file already there is replaced. */
  async write(path: string, content: FileContent, o: { mode?: string } = {}): Promise<{ path: string; size: number; sha256: string }> {
    return this.#client.json("PUT", `${this.#base}/content`, {
      query: { path, mode: o.mode },
      raw: content as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** A file's content as text (UTF-8). */
  async read(path: string): Promise<string> {
    return (await this.#client.fetch("GET", `${this.#base}/content`, { query: { path } })).text();
  }

  /** A file's content as bytes. */
  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.#client.fetch("GET", `${this.#base}/content`, { query: { path } })).arrayBuffer());
  }

  /** One level of a directory. `truncated` says whether there were more entries than `limit`. */
  async list(path: string, o: { limit?: number } = {}): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    return this.#client.json("GET", this.#base, { query: { path, limit: o.limit } });
  }

  /** One file or directory: its type, size, mode and time; with `checksum: "sha256"`, its hash. */
  async stat(path: string, o: { checksum?: "sha256" } = {}): Promise<FileEntry & { sha256?: string }> {
    return this.#client.json("GET", `${this.#base}/stat`, { query: { path, checksum: o.checksum } });
  }

  /** Remove a file, or a directory with `recursive: true`. */
  async remove(path: string, o: { recursive?: boolean } = {}): Promise<void> {
    await this.#client.fetch("DELETE", this.#base, { query: { path, recursive: o.recursive || undefined } });
  }
}

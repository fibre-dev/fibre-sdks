import { defaultClient, type Fibre } from "./client.js";
import type { TemplateData } from "./types.js";

/**
 * A template: a sandbox saved with its memory, from `sandbox.snapshot({ name })`. Sandboxes created from it with
 * `Sandbox.create({ template: name })` start already running, as the source was: the same files, the same programs.
 * A template outlives the sandbox it was taken from.
 */
export class Template {
  readonly name: string;
  #data: TemplateData;
  readonly #client: Fibre;

  /** @internal */
  constructor(client: Fibre, data: TemplateData) {
    this.#client = client;
    this.#data = data;
    this.name = data.name;
  }

  /** A template by its name. */
  static async get(name: string, client: Fibre = defaultClient()): Promise<Template> {
    return new Template(client, await client.json<TemplateData>("GET", `/v1/templates/${encodeURIComponent(name)}`));
  }

  /** Every template of the account. */
  static async list(client: Fibre = defaultClient()): Promise<Template[]> {
    const { templates } = await client.json<{ templates: TemplateData[] }>("GET", "/v1/templates");
    return templates.map((t) => new Template(client, t));
  }

  /** The sandbox it was taken from. */
  get from(): string | null {
    return this.#data.from;
  }
  get createdAt(): Date {
    return new Date(this.#data.created_at);
  }
  /** How much it stores, in bytes. */
  get sizeBytes(): number | null {
    return this.#data.size_bytes;
  }
  get data(): TemplateData {
    return this.#data;
  }

  /** Delete it. Refused while sandboxes created from it still exist. */
  async delete(): Promise<void> {
    await this.#client.fetch("DELETE", `/v1/templates/${encodeURIComponent(this.name)}`);
  }
}

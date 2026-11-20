import type { components } from "./generated/api.js";

// the API's own shapes, generated from its OpenAPI spec (src/generated/api.ts, `npm run generate`)
type Schemas = components["schemas"];

export type SandboxData = Schemas["Sandbox"] & {
  runtime_reason?: string;
  browser?: Schemas["BrowserLinks"];
  desktop_url?: string;
  desktop_expires_in?: number;
};
export type CommandData = Schemas["Command"];
// one line of a command's output stream. Declared here rather than taken from the spec: the spec allows extra fields
// on every object, which leaves a union of them with no usable field types
export type CommandLogLine =
  | { stream: "stdout" | "stderr"; data: string; offset: number }
  | { event: "end"; exit_code: number | null; status: CommandData["status"] };
export type FileEntry = Schemas["FileEntry"];
export type TemplateData = Schemas["Template"];

/** Links to a sandbox's browser. `cdpUrl` is a credential: anyone who has it can control the browser until `expiresAt`. */
export interface BrowserLinks {
  /** For a DevTools client: Playwright `chromium.connectOverCDP(cdpUrl)`, Puppeteer `connect({ browserWSEndpoint })`. */
  cdpUrl: string;
  /** A page that shows the browser and passes on clicks and keys, and nothing else: safe to share with a person. */
  liveViewUrl: string;
  expiresAt: Date;
}

/** A single-use link to a sandbox's desktop: whoever opens it first watches and uses it. */
export interface DesktopLink {
  url: string;
  /** Seconds before an unopened link expires. */
  expiresIn: number;
}

/** An image saved from a sandbox's files: use it as `image` for new sandboxes. */
export interface SavedImage {
  image: string;
  sizeBytes: number;
  /** How much of it the sandbox changed. */
  changesBytes: number;
}
export type ErrorAnswer = Schemas["Error"];

/** Where a sandbox runs: `standard` for most work, `vm` for a full virtual machine with its own kernel. */
export type Runtime = "standard" | "vm";
/** What a sandbox needs: the first five call for `vm`; `browser` and `desktop` start it with those ready. */
export type Need = "docker" | "fuse" | "cgroups" | "loop" | "iptables" | "browser" | "desktop";
export type Size = "small" | "default" | "large" | "xlarge";

/** A command: a string runs in `sh -c`, an array is the program and its arguments. */
export type CommandLine = string | string[];

/** The finished result of a command. */
export interface CommandResult {
  exitCode: number | null;
  /** `exited`, or `killed` when it was stopped. */
  status: string;
  stdout: string;
  stderr: string;
}

/** A piece of a command's output, as it was written. */
export interface OutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

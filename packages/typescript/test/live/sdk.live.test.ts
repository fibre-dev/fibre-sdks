import { afterAll, describe, expect, it } from "vitest";
import { AuthenticationError, Fibre, FibreError, NotFoundError, Sandbox, TimeoutError } from "../../src/index.js";

// against a real fibre API: FIBRE_API_KEY (and FIBRE_API_URL for another address). Every sandbox made here carries
// a label with this run's id and is deleted at the end.
const live = !!(process.env.FIBRE_API_KEY || process.env.FIBRE_TOKEN);
const RUN = `sdk-${Date.now()}`;
const labels = { "sdk-test": RUN };

describe.skipIf(!live)("the SDK against a real API", { timeout: 300_000 }, () => {
  let sbx: Sandbox;

  afterAll(async () => {
    for await (const s of Sandbox.list({ labels })) await s.delete().catch(() => {});
  });

  it("creates a sandbox", async () => {
    sbx = await Sandbox.create({ labels, lifetime: 1800 });
    expect(sbx.id).toMatch(/^sbx-[0-9a-f]{10}$/);
    expect(sbx.status).toBe("running");
    expect(sbx.runtime).toBe("standard");
    expect(sbx.runtimeReason).toBe("default");
    expect(sbx.url).toMatch(/^https:\/\//);
  });

  it("runs a command and returns its output and exit code", async () => {
    expect(await sbx.run("echo hello; echo careful >&2; exit 3")).toEqual({ exitCode: 3, status: "exited", stdout: "hello\n", stderr: "careful\n" });
    expect((await sbx.run(["python3", "-c", "print(6 * 7)"])).stdout).toBe("42\n");
  });

  it("runs a command longer than 30 seconds", async () => {
    const r = await sbx.run("sleep 35 && echo done");
    expect(r).toMatchObject({ exitCode: 0, stdout: "done\n" });
  });

  it("stops a command past its timeout", async () => {
    await expect(sbx.run("sleep 60", { timeout: 2 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("spawns a command, follows its output, finds it again by id", async () => {
    const cmd = await sbx.spawn("for i in 1 2 3; do echo line $i; sleep 1; done");
    const seen: string[] = [];
    for await (const chunk of cmd.output()) seen.push(chunk.data);
    expect(seen.join("")).toBe("line 1\nline 2\nline 3\n");
    expect(cmd.status).toBe("exited");
    expect((await sbx.command(cmd.id)).exitCode).toBe(0);
    expect((await sbx.commands()).some((c) => c.id === cmd.id)).toBe(true);
  });

  it("writes to a command's input", async () => {
    const cmd = await sbx.spawn("cat", { stdin: true });
    await cmd.write("from stdin\n");
    await cmd.closeStdin();
    expect((await cmd.wait()).stdout).toBe("from stdin\n");
  });

  it("kills a command", async () => {
    const cmd = await sbx.spawn(["sleep", "300"]);
    expect((await cmd.kill()).status).toBe("killed");
  });

  it("keeps a program running on its own", async () => {
    const cmd = await sbx.spawn(["python3", "-m", "http.server", "8000"], { keep: true });
    expect(cmd.status).toBe("detached");
    expect(cmd.pid).toBeGreaterThan(0);
    expect(cmd.log).toMatch(/^\//);
    expect((await sbx.run(`kill -0 ${cmd.pid} && echo alive`)).stdout).toBe("alive\n");
  });

  it("writes, reads, lists, stats and removes files, binary-safe", async () => {
    const bytes = new Uint8Array(256 * 64).map((_, i) => i % 256);
    expect((await sbx.files.write("/work/blob.bin", bytes)).size).toBe(bytes.length);
    expect(await sbx.files.readBytes("/work/blob.bin")).toEqual(bytes);
    await sbx.files.write("/work/hello.txt", "hello\n");
    expect(await sbx.files.read("/work/hello.txt")).toBe("hello\n");
    expect((await sbx.files.list("/work")).entries.map((e) => e.name).sort()).toEqual(["blob.bin", "hello.txt"]);
    expect((await sbx.files.stat("/work/hello.txt", { checksum: "sha256" })).sha256).toMatch(/^[0-9a-f]{64}$/);
    await sbx.files.remove("/work", { recursive: true });
    await expect(sbx.files.read("/work/hello.txt")).rejects.toMatchObject({ code: "file_not_found" });
  });

  it("finds it again by id and by labels, and updates it", async () => {
    expect((await Sandbox.get(sbx.id)).id).toBe(sbx.id);
    const found: string[] = [];
    for await (const s of Sandbox.list({ labels })) found.push(s.id);
    expect(found).toContain(sbx.id);
    const before = sbx.expiresAt.getTime();
    await new Promise((r) => setTimeout(r, 1100));
    await sbx.update({ lifetime: 3600, labels: { ...labels, stage: "review" } });
    expect(sbx.expiresAt.getTime()).toBeGreaterThan(before);
    expect(sbx.labels.stage).toBe("review");
  });

  it("works the same after the sandbox has slept", async () => {
    await sbx.update({ idleTimeout: 60 });
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000 && (await sbx.refresh()).status !== "standby") await new Promise((r) => setTimeout(r, 5000));
    expect(sbx.status).toBe("standby");
    expect((await sbx.run("echo awake")).stdout).toBe("awake\n");
    expect((await sbx.refresh()).status).toBe("running");
  });

  it("runs on the vm runtime the same way", async () => {
    const vm = await Sandbox.create({ runtime: "vm", labels, lifetime: 900 });
    expect(vm.runtime).toBe("vm");
    expect((await vm.run("echo from a vm")).stdout).toBe("from a vm\n");
    await vm.delete();
  });

  it("answers errors as typed errors with their code", async () => {
    const e = await Sandbox.get("sbx-0000000000").catch((x) => x);
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e).toMatchObject({ code: "sandbox_not_found", status: 404 });
    expect(e.docsUrl).toContain("sandbox_not_found");
    expect(e.requestId).toBeTruthy();
    const refused = await Sandbox.create({ runtime: "standard", needs: ["docker"], labels }).catch((x) => x);
    expect(refused).toBeInstanceOf(FibreError);
    expect(refused.code).toBe("needs_vm");
    const bad = await Sandbox.get(sbx.id, new Fibre({ apiKey: "not-a-key" })).catch((x) => x);
    expect(bad).toBeInstanceOf(AuthenticationError);
  });

  it("deletes it", async () => {
    await sbx.delete();
    await expect(Sandbox.get(sbx.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

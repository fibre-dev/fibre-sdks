import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";
import { ConflictError, FibreError, Sandbox, Template } from "../../src/index.js";

// templates, saved images, the browser and the desktop, against a real fibre API (FIBRE_API_KEY, FIBRE_API_URL).
// Every sandbox and template made here carries this run's id and is deleted at the end.
const live = !!(process.env.FIBRE_API_KEY || process.env.FIBRE_TOKEN);
const RUN = `sdk-${Date.now()}`;
const labels = { "sdk-test": RUN };
const templates: string[] = [];

// a file and a running program to find again in a copy
async function prepare(sbx: Sandbox): Promise<number> {
  await sbx.files.write("/work/marker.txt", RUN);
  const kept = await sbx.spawn(["python3", "-c", "import time\nwhile True: time.sleep(1)"], { keep: true });
  return kept.pid!;
}

describe.skipIf(!live)("templates, images, browser and desktop against a real API", { timeout: 600_000 }, () => {
  afterAll(async () => {
    for await (const s of Sandbox.list({ labels })) await s.delete().catch(() => {});
    for (const name of templates) await (await Template.get(name).catch(() => null))?.delete().catch(() => {});
  });

  for (const runtime of ["standard", "vm"] as const) {
    it(`${runtime}: a template starts copies with the source's files and running programs`, async () => {
      const src = await Sandbox.create({ runtime, labels, lifetime: 1800 });
      const pid = await prepare(src);
      const name = `${RUN}-${runtime}`;
      templates.push(name);
      const tpl = await src.snapshot({ name });
      expect(tpl.name).toBe(name);
      expect(tpl.from).toBe(src.id);
      expect((await Template.list()).some((t) => t.name === name)).toBe(true);

      const copy = await Sandbox.create({ template: name, labels, lifetime: 900 });
      expect(copy.runtime).toBe(runtime);
      expect(await copy.files.read("/work/marker.txt")).toBe(RUN);
      expect((await copy.run(`kill -0 ${pid} && echo running`)).stdout).toBe("running\n");
      expect((await src.run("echo still here")).stdout).toBe("still here\n");

      await copy.delete();
      await src.delete();
      await (await Template.get(name)).delete();
      templates.splice(templates.indexOf(name), 1);
    });
  }

  it("standard: saves its files as an image that new sandboxes run", async () => {
    const src = await Sandbox.create({ labels, lifetime: 900 });
    await src.files.write("/opt/app/version.txt", RUN);
    const saved = await src.saveImage();
    expect(saved.image).toMatch(/^build\//);
    expect(saved.changesBytes).toBeGreaterThan(0);
    // an image of your own waits for a port by default; this one serves nothing
    const next = await Sandbox.create({ image: saved.image, ready: "process", labels, lifetime: 900 });
    expect(await next.files.read("/opt/app/version.txt")).toBe(RUN);
    await next.delete();
    await src.delete();
  });

  it("vm: saving an image is refused with its code", async () => {
    const vm = await Sandbox.create({ runtime: "vm", labels, lifetime: 600 });
    const e = await vm.saveImage().catch((x) => x);
    expect(e).toBeInstanceOf(ConflictError);
    expect(e.code).toBe("snapshot_needs_standard");
    await vm.delete();
  });

  it("browser(): Playwright connects, drives a page, and the links are revoked", async () => {
    const sbx = await Sandbox.create({ labels, lifetime: 900 });
    const links = await sbx.browser({ ttl: 600 });
    expect(links.cdpUrl).toMatch(/^wss?:\/\//);
    expect(links.liveViewUrl).toMatch(/^https?:\/\//);
    expect(links.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const browser = await chromium.connectOverCDP(links.cdpUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent("<title>from the sdk</title><h1 id=h>hello</h1>");
    expect(await page.title()).toBe("from the sdk");
    expect(await page.textContent("#h")).toBe("hello");
    await browser.close();

    expect((await fetch(links.liveViewUrl)).status).toBe(200);
    await sbx.closeBrowser();
    const after = await chromium.connectOverCDP(links.cdpUrl, { timeout: 10_000 }).then(
      (b) => b.close().then(() => "connected"),
      () => "refused",
    );
    expect(after).toBe("refused");
    await sbx.delete();
  });

  it('needs: ["browser"] starts it with the browser ready, on vm', async () => {
    const sbx = await Sandbox.create({ needs: ["browser"], labels, lifetime: 600 });
    expect(sbx.runtime).toBe("vm");
    expect(sbx.runtimeReason).toBe("needs:browser");
    expect(sbx.data.browser?.cdp_url).toMatch(/^wss?:\/\//);
    await sbx.delete();
  });

  it("desktop(): a single-use link to a desktop sandbox", async () => {
    const sbx = await Sandbox.create({ needs: ["desktop"], labels, lifetime: 600 });
    expect(sbx.runtime).toBe("vm");
    expect(sbx.data.desktop_url).toBeTruthy();
    const link = await sbx.desktop();
    expect(link.url).toMatch(/^https?:\/\//);
    expect(link.expiresIn).toBe(300);
    expect((await sbx.run("DISPLAY=:1 scrot -o /tmp/s.png && echo shot")).stdout).toBe("shot\n");
    await sbx.delete();
  });

  it("an unknown template is a typed error", async () => {
    const e = await Sandbox.create({ template: `${RUN}-none`, labels }).catch((x) => x);
    expect(e).toBeInstanceOf(FibreError);
    expect(e.status).toBeGreaterThanOrEqual(400);
  });
});

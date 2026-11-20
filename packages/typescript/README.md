# @fibre-dev/sdk

The TypeScript SDK for [fibre](https://fibre.dev): sandboxes for agents and the code they write. A sandbox is an
isolated Linux machine you start with one call. When nobody uses it, it sleeps with its memory and comes back on the
next call, and every method here works the same whether it is awake or asleep.

```bash
npm install @fibre-dev/sdk
```

Set `FIBRE_API_KEY` to your API key.

```ts
import { Sandbox } from "@fibre-dev/sdk";

const sbx = await Sandbox.create();
const result = await sbx.run("python3 -c 'print(40 + 2)'");
console.log(result.stdout); // 42

await sbx.delete();
```

## running commands

```ts
// wait for it: its exit code and all of its output, with no time limit unless you give one
const { exitCode, stdout, stderr } = await sbx.run("npm test", { cwd: "/app", timeout: 600 });

// or start it and follow it
const build = await sbx.spawn("npm run build", { cwd: "/app" });
for await (const { stream, data } of build.output()) process[stream].write(data);

// a dev server or a database: kept running on its own, across the sandbox's sleep
const server = await sbx.spawn("npm run dev", { cwd: "/app", keep: true });

// find a command again later, from anywhere
const again = await sbx.command(build.id);
await again.kill();
```

## files

```ts
await sbx.files.write("/app/main.py", "print('hello')");
const text = await sbx.files.read("/app/main.py");
const bytes = await sbx.files.readBytes("/app/data.bin");
const { entries } = await sbx.files.list("/app");
await sbx.files.remove("/app", { recursive: true });
```

## finding sandboxes again

```ts
const sbx = await Sandbox.create({ labels: { team: "docs" }, lifetime: 3600, idleTimeout: 300 });

const same = await Sandbox.get(sbx.id);
for await (const s of Sandbox.list({ labels: { team: "docs" } })) console.log(s.id, s.status);

await sbx.update({ lifetime: 7200 }); // a new lifetime, counted from now
```

## runtimes

Leave `runtime` out and fibre picks: `standard` for most work, `vm` (a full virtual machine with its own kernel) when
the sandbox needs one. Say what it needs and fibre chooses:

```ts
const vm = await Sandbox.create({ needs: ["docker"] });
console.log(vm.runtime, vm.runtimeReason); // vm needs:docker
```

## errors

Every error is a `FibreError` with a stable `code`, the `requestId`, and a `docsUrl` that explains it. Catch the kind
you care about:

```ts
import { NotFoundError, RateLimitError } from "@fibre-dev/sdk";

try {
  await Sandbox.get("sbx-0000000000");
} catch (e) {
  if (e instanceof NotFoundError) console.log(e.code); // sandbox_not_found
}
```

Requests that failed to connect, or met a busy API, are tried again on their own (`maxRetries`, 2); creating a
sandbox is safe to retry.

## more than one key, or another address

```ts
import { Fibre, Sandbox } from "@fibre-dev/sdk";

const client = new Fibre({ apiKey: "…", baseUrl: "https://api.fibre.dev", timeout: 60, maxRetries: 2 });
const sbx = await Sandbox.create({ size: "small" }, client);
```

Node 20 and later, Bun and Deno. No dependencies.

## license

MIT

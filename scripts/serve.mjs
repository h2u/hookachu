import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const config = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const bundled = await build({
  entryPoints: [config.main],
  bundle: true,
  write: false,
  format: "esm",
  external: ["cloudflare:workers"],
});
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    host: "0.0.0.0",
    port: 8787,
    cf: false,
    telemetry: { enabled: false },
    logRequests: false,
    resourcePersistencePath: process.env.DATA_DIR || "./.wrangler/self-hosted",
    workers: [
      {
        name: config.name,
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: config.compatibility_date,
        bindings: config.vars,
        durableObjects: Object.fromEntries(
          config.durable_objects.bindings.map((binding) => [
            binding.name,
            { className: binding.class_name, useSQLite: true },
          ]),
        ),
        ratelimits: Object.fromEntries(
          config.ratelimits.map(({ name, ...options }) => [name, options]),
        ),
        assets: {
          routerConfig: { has_user_worker: true },
          directory: config.assets.directory,
          binding: config.assets.binding,
          run_worker_first: config.assets.run_worker_first,
          assetConfig: { not_found_handling: config.assets.not_found_handling },
        },
      },
    ],
  }),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await runtime.dispose();
    process.exit(0);
  });
}
await runtime.ready;
console.log("Hookachu listening on http://0.0.0.0:8787");

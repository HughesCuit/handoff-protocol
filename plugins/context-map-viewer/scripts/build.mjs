import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "server/server.mjs")],
  outfile: resolve(dist, "server.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
});

const widget = await build({
  entryPoints: [resolve(root, "web/app.mjs")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: true,
});

const [template, styles] = await Promise.all([
  readFile(resolve(root, "web/index.html"), "utf8"),
  readFile(resolve(root, "web/styles.css"), "utf8"),
]);
const html = template
  .replace("/*__STYLES__*/", styles)
  .replace("/*__APP__*/", widget.outputFiles[0].text);
await writeFile(resolve(dist, "widget.html"), html);

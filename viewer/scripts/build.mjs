import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "web/app.mjs")],
  outfile: resolve(dist, "app.mjs"),
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: false,
  minify: true,
  external: ["./model.mjs"],
});

await Promise.all([
  copyFile(resolve(root, "web/model.mjs"), resolve(dist, "model.mjs")),
  copyFile(resolve(root, "web/styles.css"), resolve(dist, "styles.css")),
  copyFile(resolve(root, "web/standalone.html"), resolve(dist, "index.html")),
]);

console.log("Built viewer assets into viewer/dist/");

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const standalone = resolve(dist, "standalone");
await mkdir(dist, { recursive: true });
await mkdir(standalone, { recursive: true });

function transportPlugin(mode) {
  const transports = JSON.stringify(resolve(root, "web/transports.mjs"));
  const contents = mode === "mcp"
    ? `import { createMcpTransport, createPageLifecycle } from ${transports};
       export { createPageLifecycle };
       export function createPageTransport(_document, dependencies) {
         return createMcpTransport(dependencies);
       }`
    : `import { createHttpTransport, createPageLifecycle } from ${transports};
       export { createPageLifecycle };
       export function createPageTransport(_document, dependencies) {
         return createHttpTransport(dependencies);
       }`;
  return {
    name: `context-map-${mode}-transport`,
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/transports\.mjs$/ }, (args) => {
        if (args.importer !== resolve(root, "web/app.mjs")) return undefined;
        return { path: mode, namespace: "context-map-transport" };
      });
      buildContext.onLoad({ filter: /.*/, namespace: "context-map-transport" }, () => ({
        contents,
        loader: "js",
        resolveDir: root,
      }));
    },
  };
}

await build({
  entryPoints: [resolve(root, "server/server.mjs")],
  outfile: resolve(dist, "server.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  minify: true,
});

const widget = await build({
  entryPoints: [resolve(root, "web/app.mjs")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: true,
  plugins: [transportPlugin("mcp")],
});

const [template, styles] = await Promise.all([
  readFile(resolve(root, "web/index.html"), "utf8"),
  readFile(resolve(root, "web/styles.css"), "utf8"),
]);
const html = template
  .replace("/*__STYLES__*/", styles)
  .replace("/*__APP__*/", widget.outputFiles[0].text);
await writeFile(resolve(dist, "widget.html"), html);

await build({
  entryPoints: [resolve(root, "web/app.mjs")],
  outfile: resolve(standalone, "app.mjs"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  external: ["./model.mjs"],
  plugins: [transportPlugin("http")],
});

await Promise.all([
  copyFile(resolve(root, "web/model.mjs"), resolve(standalone, "model.mjs")),
  copyFile(resolve(root, "web/styles.css"), resolve(standalone, "styles.css")),
  copyFile(resolve(root, "web/standalone.html"), resolve(standalone, "index.html")),
]);

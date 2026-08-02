// @ts-nocheck
/**
 * Handoff Protocol — View command behavior tests (Deno).
 *
 * The Viewer daemon is Node.js-only, so the Deno `view` command must return the
 * stable VIEW_REQUIRES_NODE error with an actionable Node command and exit code
 * 1. All other Handoff Deno commands are unaffected and covered elsewhere.
 *
 * Run: deno test --allow-read --allow-write --allow-run --allow-env tests/deno/
 */

import { assert, assertEqual, assertIncludes } from "../shared/unit-suite.mjs";

const root = new URL("../../", import.meta.url);
const deno = Deno.execPath();

function runView(args = []) {
  return new Deno.Command(deno, {
    args: ["run", new URL("scripts/view.ts", root).pathname, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output().then((out) => ({
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }));
}

Deno.test("view returns VIEW_REQUIRES_NODE with an actionable Node command", async () => {
  const result = await runView();
  assertEqual(result.code, 1, "view must exit with code 1");
  assertEqual(result.stdout, "", "human mode must print to stderr, not stdout");
  assertIncludes(result.stderr, "VIEW_REQUIRES_NODE");
  assertIncludes(result.stderr, "node scripts/node/view.mjs");
});

Deno.test("view --json emits one stable JSON error object on stdout", async () => {
  const result = await runView(["--json"]);
  assertEqual(result.code, 1, "view --json must exit with code 1");
  assertEqual(result.stdout.trim().split("\n").length, 1, "JSON output must be a single line");
  const parsed = JSON.parse(result.stdout);
  assertEqual(parsed.status, "error");
  assertEqual(parsed.error, "VIEW_REQUIRES_NODE");
  assertEqual(parsed.nodeCommand, "node scripts/node/view.mjs");
});

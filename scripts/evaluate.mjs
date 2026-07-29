#!/usr/bin/env node

/**
 * Handoff Protocol — real-project evaluation runner.
 *
 * Builds a synthetic project in a temporary directory (source fixtures are
 * never modified), runs repeated saves against it, and reports the quality
 * metrics the protocol promises:
 *
 *   - duplicate rate:       map nodes duplicated by repeated saves (expect 0)
 *   - user-edit retention:  user-edited / user-added nodes surviving later saves
 *   - growth rate:          context-map.md byte growth across saves (expect 0
 *                           once state is stable)
 *   - runtime parity:       Node and Deno saves produce equivalent maps from
 *                           identical repositories
 *
 * Usage:
 *   node scripts/evaluate.mjs [--deno /path/to/deno] [--saves 3]
 *
 * Exit code is non-zero when duplicates appear, user edits are lost, or the
 * runtimes diverge. A missing Deno runtime skips (not fails) the parity leg.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAP_FILENAME,
  normalizeNodeText,
  parseContextMap,
  SECTION_KEYS,
} from "./context-map.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function optValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const saveCount = Math.max(2, parseInt(optValue("--saves") || "3", 10));

function findDeno() {
  const explicit = optValue("--deno") || process.env.DENO;
  if (explicit) return explicit;
  const res = spawnSync("deno", ["--version"], { encoding: "utf-8" });
  return res.status === 0 ? "deno" : null;
}

// ── Project scaffolding (temp dirs only; fixtures are never touched) ─────────

function git(cwd, gitArgs) {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf-8" }).trim();
}

function initProject(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "eval@example.com"]);
  git(dir, ["config", "user.name", "Eval"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "eval-app" }) + "\n");
  writeFileSync(join(dir, ".gitignore"), ".handoff/\n");
  writeFileSync(
    join(dir, ".handoff.config.json"),
    JSON.stringify({ version: "1.5.1", storage: { mode: "direct", path: ".handoff" } }, null, 2) + "\n"
  );
  writeFileSync(
    join(dir, "app.ts"),
    ["// TODO: wire the evaluation harness", "// FIXME: handle empty maps", ""].join("\n")
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "feat: evaluate handoff saves"]);
  writeFileSync(join(dir, "app.ts"), "// TODO: wire the evaluation harness\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "fix: keep a single pending todo"]);
}

function runNodeSave(dir) {
  execFileSync(process.execPath, [join(root, "scripts", "node", "save.mjs")], { cwd: dir, encoding: "utf-8" });
}

function runDenoSave(deno, dir) {
  execFileSync(
    deno,
    ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", join(root, "scripts", "save.ts")],
    { cwd: dir, encoding: "utf-8" }
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────────

function mapStats(map) {
  let total = 0;
  let duplicates = 0;
  for (const key of SECTION_KEYS) {
    const seen = new Map();
    for (const node of map.sections[key]) {
      total += 1;
      const text = normalizeNodeText(node.text);
      seen.set(text, (seen.get(text) || 0) + 1);
    }
    for (const count of seen.values()) {
      if (count > 1) duplicates += count - 1;
    }
  }
  return { total, duplicates };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const workdir = mkdtempSync(join(tmpdir(), "handoff-eval-"));
const project = join(workdir, "project");
initProject(project);
const mapPath = join(project, ".handoff", MAP_FILENAME);

const sizes = [];
runNodeSave(project);
sizes.push(readFileSync(mapPath, "utf-8").length);

// Simulate a human curating the map between saves: edit the inferred goal and
// add a task without an agent marker (both become user-owned nodes).
const editedGoal = "User-curated evaluation goal";
const editedTask = "User-added evaluation task";
const firstMap = readFileSync(mapPath, "utf-8");
const goalLine = firstMap.match(/^- .+ <!-- agent -->.*$/m);
if (!goalLine) {
  console.error("FAIL: could not locate an agent-owned goal node to edit");
  process.exit(1);
}
const curated = firstMap
  .replace(goalLine[0], `- ${editedGoal}`)
  .replace("## Tasks\n", `## Tasks\n\n- [ ] ${editedTask}\n`);
writeFileSync(mapPath, curated);

for (let i = 1; i < saveCount; i++) {
  runNodeSave(project);
  sizes.push(readFileSync(mapPath, "utf-8").length);
}

const finalContent = readFileSync(mapPath, "utf-8");
const finalMap = parseContextMap(finalContent);
if (!finalMap) {
  console.error("FAIL: final context map does not parse");
  process.exit(1);
}

const { total, duplicates } = mapStats(finalMap);
const duplicateRate = total === 0 ? 0 : duplicates / total;

const edits = [editedGoal, editedTask];
const retained = edits.filter((text) => finalContent.includes(text));
const retention = retained.length / edits.length;

const steadyGrowth = (sizes[sizes.length - 1] - sizes[sizes.length - 2]) / sizes[sizes.length - 2];
const overallGrowth = (sizes[sizes.length - 1] - sizes[0]) / sizes[0];

// Runtime parity: copy the pre-save repository so both runtimes start from an
// identical git history, then compare the parsed maps.
const deno = findDeno();
let parity = "skipped (deno not found; pass --deno /path/to/deno)";
let parityFailed = false;
if (deno) {
  const nodeDir = join(workdir, "parity-node");
  const denoDir = join(workdir, "parity-deno");
  initProject(nodeDir);
  cpSync(nodeDir, denoDir, { recursive: true });
  runNodeSave(nodeDir);
  runDenoSave(deno, denoDir);
  const nodeMap = parseContextMap(readFileSync(join(nodeDir, ".handoff", MAP_FILENAME), "utf-8"));
  const denoMap = parseContextMap(readFileSync(join(denoDir, ".handoff", MAP_FILENAME), "utf-8"));
  const equivalent = JSON.stringify(nodeMap.sections) === JSON.stringify(denoMap.sections);
  parity = equivalent ? "pass (node and deno maps equivalent)" : "FAIL (maps diverged)";
  parityFailed = !equivalent;
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
console.log("");
console.log("Handoff Protocol evaluation");
console.log(`  workdir:             ${workdir} (temporary; fixtures untouched)`);
console.log(`  saves:               ${saveCount} (node)`);
console.log(`  duplicate rate:      ${pct(duplicateRate)} (${duplicates}/${total} nodes)`);
console.log(`  user-edit retention: ${pct(retention)} (${retained.length}/${edits.length} edits)`);
console.log(`  growth rate:         ${pct(steadyGrowth)} steady-state (last two saves), ${pct(overallGrowth)} overall (first to last, includes user edits)`);
console.log(`  runtime parity:      ${parity}`);

const failed = duplicates > 0 || retention < 1 || parityFailed;
console.log(`  result:              ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);

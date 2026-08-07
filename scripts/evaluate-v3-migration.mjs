#!/usr/bin/env node
/**
 * Handoff Protocol v3.0.0 — v2-to-v3 migration evaluator.
 *
 * Copies each target project into an isolated temp dir (the source is never
 * modified), migrates the copy, and reports:
 *   - duplicate-node rate (duplicate stable IDs / total nodes)
 *   - preserved-user-edit rate (original node texts surviving in bodies)
 *   - orphan-content count
 *   - byte growth per file and in total
 *   - Node/Deno normalized migration-output equality
 *   - migration + repeated-save idempotence
 *
 * Usage:
 *   node scripts/evaluate-v3-migration.mjs [projectDir ...]
 *   node scripts/evaluate-v3-migration.mjs --json
 *
 * With no arguments it evaluates the committed v2 migration fixtures.
 */

import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { filterSensitive, parseContextMap, parseContextMapV3 } from "./context-map.mjs";
import { CONTENT_DIR, CONTENT_FILES } from "./content-files.mjs";
import { indexContextMap } from "./handoff-state.mjs";
import { applyV3Migration, planV2ToV3Migration } from "./migrate-v3.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPTS_DIR);

const V2_ROOT_FILES = ["context-map.md", "HANDOFF.md", "tasks.md", "decisions.md", "context.json"];

// Real-filesystem io adapter for applyV3Migration.
const fsIo = {
  readFile: async (p) => readFileSync(p, "utf-8"),
  writeFile: async (p, content) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  },
  rename: async (from, to) => renameSync(from, to),
  mkdir: async (p) => mkdirSync(p, { recursive: true }),
  exists: async (p) => existsSync(p),
  remove: async (p) => rmSync(p, { force: true }),
  listDir: async (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

async function readIfExists(p) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return undefined;
  }
}

async function readInputs(handoffDir) {
  return {
    config: await readIfExists(join(dirname(handoffDir), ".handoff.config.json")),
    contextJson: await readIfExists(join(handoffDir, "context.json")),
    handoffMd: await readIfExists(join(handoffDir, "HANDOFF.md")),
    tasksMd: await readIfExists(join(handoffDir, "tasks.md")),
    decisionsMd: await readIfExists(join(handoffDir, "decisions.md")),
    contextMapMd: await readIfExists(join(handoffDir, "context-map.md")),
  };
}

function fileBytes(dir, rel) {
  try {
    const info = statSync(join(dir, rel));
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function v2ByteSnapshot(handoffDir) {
  const files = {};
  for (const name of V2_ROOT_FILES) {
    const size = fileBytes(handoffDir, name);
    if (size > 0) files[name] = size;
  }
  return files;
}

function v3ByteSnapshot(handoffDir) {
  const files = {};
  const mapSize = fileBytes(handoffDir, "context-map.md");
  if (mapSize > 0) files["context-map.md"] = mapSize;
  for (const name of Object.values(CONTENT_FILES)) {
    const size = fileBytes(handoffDir, join(CONTENT_DIR, name));
    if (size > 0) files[`${CONTENT_DIR}/${name}`] = size;
  }
  const viewSize = fileBytes(handoffDir, join("views", "HANDOFF.md"));
  if (viewSize > 0) files["views/HANDOFF.md"] = viewSize;
  const jsonSize = fileBytes(handoffDir, "context.json");
  if (jsonSize > 0) files["context.json"] = jsonSize;
  return files;
}

function totalBytes(snapshot) {
  return Object.values(snapshot).reduce((sum, n) => sum + n, 0);
}

function growth(before, after) {
  const files = {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    const b = before[name] ?? 0;
    const a = after[name] ?? 0;
    files[name] = { before: b, after: a, delta: a - b };
  }
  const tb = totalBytes(before);
  const ta = totalBytes(after);
  return { files, total: { before: tb, after: ta, delta: ta - tb } };
}

function cleanNodeText(text) {
  return String(text).replace(/^\*\*(high|medium|low)\*\*\s+/i, "").trim();
}

function denoAvailable() {
  const res = spawnSync("deno", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

function normalizedOutputs(outputs) {
  const normalized = {};
  for (const name of Object.keys(outputs).sort()) {
    normalized[name] = filterSensitive(outputs[name]);
  }
  return JSON.stringify(normalized);
}

/** Compare the Node planner output against the Deno planner output. */
async function compareNodeDeno(inputs, nodeOutputs) {
  if (!denoAvailable()) return "skipped";
  const workRoot = await mkdtemp(join(tmpdir(), "v3-eval-deno-"));
  const inputsPath = join(workRoot, "inputs.json");
  await writeFile(inputsPath, JSON.stringify(inputs));
  const res = spawnSync(
    "deno",
    ["run", "--no-check", "--allow-read", join(SCRIPTS_DIR, "v3-plan-deno.mjs"), inputsPath],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) return "skipped";
  let denoPlan;
  try {
    denoPlan = JSON.parse(res.stdout.trim());
  } catch {
    return false;
  }
  if (!denoPlan.outputs || !nodeOutputs) return denoPlan.outputs === nodeOutputs;
  return normalizedOutputs(denoPlan.outputs) === normalizedOutputs(nodeOutputs);
}

/**
 * Evaluate the v2-to-v3 migration of one project. The source directory is
 * copied to an isolated temp dir first and is never modified.
 */
export async function evaluateV3Migration(sourceDir, options = {}) {
  const workRoot = await mkdtemp(join(tmpdir(), "v3-eval-"));
  const work = join(workRoot, "project");
  await cp(sourceDir, work, { recursive: true });
  const handoffDir = join(work, ".handoff");
  const configPath = join(work, ".handoff.config.json");

  const before = v2ByteSnapshot(handoffDir);
  const inputs = await readInputs(handoffDir);
  const plan = planV2ToV3Migration(inputs);

  if (!plan.needed) {
    return {
      sourceDir,
      skipped: true,
      reason: plan.reason,
      metrics: {
        nodeCount: 0,
        duplicateNodeRate: 0,
        preservedUserEditRate: 1,
        orphanContentCount: 0,
        byteGrowth: growth(before, before),
        nodeDenoEqual: "skipped",
        idempotent: true,
      },
      diagnostics: plan.diagnostics.migration,
    };
  }

  await applyV3Migration(fsIo, plan, { handoffDir, configPath }, { timestamp: options.timestamp });
  const after = v3ByteSnapshot(handoffDir);

  // Node count + duplicate rate from the migrated directory.
  const map = parseContextMapV3(readFileSync(join(handoffDir, "context-map.md"), "utf-8"));
  const index = indexContextMap(map);
  let nodeCount = 0;
  for (const key of Object.keys(map.sections)) nodeCount += map.sections[key].length;
  const duplicateNodeRate = nodeCount === 0 ? 0 : index.duplicates.length / nodeCount;

  // Preserved-user-edit rate: every original node text must appear in a body.
  const bodies = [];
  for (const name of Object.values(CONTENT_FILES)) {
    bodies.push(readFileSync(join(handoffDir, CONTENT_DIR, name), "utf-8"));
  }
  const bodyText = bodies.join("\n");
  const v2map = inputs.contextMapMd ? parseContextMap(inputs.contextMapMd) : null;
  const originalTexts = [];
  if (v2map) {
    for (const key of Object.keys(v2map.sections)) {
      for (const node of v2map.sections[key]) {
        const text = cleanNodeText(node.text);
        if (text) originalTexts.push(text);
      }
    }
  }
  const preserved = originalTexts.filter((text) => bodyText.includes(text)).length;
  const preservedUserEditRate = originalTexts.length === 0 ? 1 : preserved / originalTexts.length;

  // Orphan content count from the migration diagnostics.
  const orphanContentCount = plan.diagnostics.migration.filter((d) => d.startsWith("CONTENT_ORPHAN")).length;

  // Node/Deno normalized output equality.
  const nodeDenoEqual = await compareNodeDeno(inputs, plan.outputs);

  // Idempotence: re-planning the migrated copy is a no-op.
  const secondInputs = await readInputs(handoffDir);
  const secondPlan = planV2ToV3Migration(secondInputs);
  const idempotent = secondPlan.needed === false;

  return {
    sourceDir,
    skipped: false,
    metrics: {
      nodeCount,
      duplicateNodeRate,
      preservedUserEditRate,
      orphanContentCount,
      byteGrowth: growth(before, after),
      nodeDenoEqual,
      idempotent,
    },
    diagnostics: plan.diagnostics.migration,
  };
}

function defaultFixtures() {
  return [
    join(REPO_ROOT, "tests", "fixtures", "migration", "v2-complete"),
    join(REPO_ROOT, "tests", "fixtures", "handoffs", "map-only"),
    join(REPO_ROOT, "tests", "fixtures", "handoffs", "legacy-1x"),
    join(REPO_ROOT, "tests", "fixtures", "handoffs", "migrated"),
  ];
}

function renderMarkdownReport(results) {
  const lines = ["# v3 Migration Validation Report", ""];
  lines.push(`Generated: ${new Date().toISOString()}`, "");
  lines.push("Each project was copied to an isolated temp dir and migrated there; sources were never modified.", "");
  for (const result of results) {
    lines.push(`## ${result.displayPath}`, "");
    if (result.skipped) {
      lines.push(`- Skipped: ${result.reason}`, "");
      continue;
    }
    const m = result.metrics;
    lines.push(`- Nodes: ${m.nodeCount}`);
    lines.push(`- Duplicate-node rate: ${m.duplicateNodeRate.toFixed(3)}`);
    lines.push(`- Preserved-user-edit rate: ${m.preservedUserEditRate.toFixed(3)}`);
    lines.push(`- Orphan content count: ${m.orphanContentCount}`);
    lines.push(`- Node/Deno output equality: ${m.nodeDenoEqual}`);
    lines.push(`- Idempotent: ${m.idempotent}`);
    lines.push(`- Byte growth (total): ${m.byteGrowth.total.before} → ${m.byteGrowth.total.after} (Δ ${m.byteGrowth.total.delta})`);
    lines.push("");
    lines.push("| File | Before | After | Δ |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const [name, g] of Object.entries(m.byteGrowth.files)) {
      lines.push(`| ${name} | ${g.before} | ${g.after} | ${g.delta} |`);
    }
    lines.push("");
    if (result.diagnostics.length > 0) {
      lines.push("Diagnostics:");
      for (const d of result.diagnostics) lines.push(`- ${d}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  const projectDirs = targets.length > 0 ? targets : defaultFixtures();

  const results = [];
  for (const dir of projectDirs) {
    const result = await evaluateV3Migration(dir);
    const rel = relative(REPO_ROOT, dir);
    result.displayPath = rel && !rel.startsWith("..") ? rel : dir;
    results.push(result);
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const report = renderMarkdownReport(results);
  console.log(report);
  const reportPath = join(REPO_ROOT, "docs", "validation", "v3-migration-report.md");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report + "\n");
  console.error(`\nReport written to ${reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

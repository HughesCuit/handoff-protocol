// @ts-nocheck
/**
 * Handoff Protocol v2.3 — Semantic context diff (shared module).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/diff.ts) and the Node.js implementation (scripts/node/diff.mjs).
 * It intentionally uses no runtime-specific APIs (no `Deno.*`, no `node:*`):
 * runDiff performs all filesystem work through an injected `io` adapter, so
 * behavior stays identical across runtimes and is testable with an in-memory
 * filesystem.
 *
 * Diff contract
 * -------------
 * `/handoff diff [--from latest|<snapshot-id>] [--format markdown|json]`
 * compares a semantic snapshot against the CURRENT normalized state of the
 * canonical Context Map, and reports added, removed, edited, moved, and
 * task-state-changed nodes as separate, stable arrays. Without `--from`,
 * the baseline is the previous semantic snapshot: the newest snapshot under
 * `.handoff/history/snapshots/`, unless its digest equals the current
 * state's digest (the save → diff sequence), in which case the snapshot
 * before it is used. `--from latest` is literal: always the newest one.
 *
 * Node matching is content-based — no persistent node IDs exist anywhere.
 * Nodes are flattened per section with a hierarchy path ("Parent > Child")
 * derived from list depth, then matched in three passes:
 *   1. exact text (same section first, then across sections) — unmatched
 *      position changes surface as moves, checkbox flips as task-state
 *      changes;
 *   2. same-section, same-depth positional pairing of the leftovers — these
 *      surface as edits (an edit is NOT reported as remove+add);
 *   3. whatever remains is a pure addition or removal.
 *
 * Identical texts in different positions are paired by occurrence order, so
 * duplicates never produce phantom moves. Because both sides are normalized
 * snapshot states (buildSnapshot), the comparison is independent of localized
 * headings and generated agent fingerprints.
 *
 * The command is strictly read-only: it never writes, renames, or removes
 * snapshots, the Context Map, or any other file. All rendered output passes
 * the sensitive-data filter before display.
 */

import {
  CONTEXT_MAP_FILE,
  filterSensitive,
  parseContextMap,
} from "./context-map.mjs";
import {
  SNAPSHOT_DIR,
  SNAPSHOT_FILE_RE,
  buildSnapshot,
  snapshotDigest,
} from "./snapshots.mjs";

/** Output formats accepted by `--format`. */
export const DIFF_FORMATS = ["markdown", "json"];
/** Change-class keys, in report order. */
export const DIFF_CLASSES = ["added", "removed", "edited", "moved", "taskStateChanged"];

const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;

// ── Flattening ───────────────────────────────────────────────────────────────

/**
 * Flatten a normalized snapshot state into content-addressable nodes.
 * Each entry: { section, path, text, checked? } where path is the hierarchy
 * chain of node texts ("Parent > Child") reconstructed from list depth.
 * Extras are preserved under their sanitized heading with flat body lines.
 */
export function flattenState(state) {
  const nodes = [];
  const sections = (state && state.sections) || {};
  for (const section of Object.keys(sections)) {
    const stack = [];
    for (const raw of sections[section] || []) {
      const node = {
        section,
        text: String(raw && raw.text != null ? raw.text : ""),
        depth: Math.max(0, Number(raw && raw.depth) || 0),
      };
      if (section === "tasks") node.checked = !!(raw && raw.checked);
      if (node.depth > stack.length) node.depth = stack.length;
      stack.length = node.depth;
      stack.push(node.text);
      node.path = stack.join(" > ");
      nodes.push(node);
    }
  }
  for (const extra of (state && state.extras) || []) {
    const section = String((extra && extra.heading) || "");
    for (const line of (extra && extra.body) || []) {
      const text = String(line);
      nodes.push({ section, text, depth: 0, path: text });
    }
  }
  return nodes;
}

// ── Matching ─────────────────────────────────────────────────────────────────

function matchByText(beforePool, afterPool, sameSectionOnly) {
  const pairs = [];
  for (const b of beforePool) {
    const idx = afterPool.findIndex(
      (a) => a.text === b.text && (!sameSectionOnly || a.section === b.section)
    );
    if (idx === -1) continue;
    pairs.push([b, afterPool[idx]]);
    afterPool.splice(idx, 1);
  }
  return pairs;
}

/**
 * Compute the semantic diff between two normalized states (before → after).
 * Returns { added, removed, edited, moved, taskStateChanged }, each a stable
 * array in document order:
 *   added:            { section, path, after }
 *   removed:          { section, path, before }
 *   edited:           { section, path, before, after }
 *   moved:            { section, path, text, before: {section, path}, after: {section, path} }
 *   taskStateChanged: { section, path, text, task: { before, after } }
 */
export function diffStates(beforeState, afterState) {
  const beforeNodes = flattenState(beforeState);
  const afterNodes = flattenState(afterState);

  const moved = [];
  const taskStateChanged = [];
  const beforePool = [...beforeNodes];
  const afterPool = [...afterNodes];

  // Pass 1: exact-text matches (same section, then cross-section). Occurrence
  // order pairs duplicates deterministically, so identical texts in different
  // positions never produce phantom changes. Matched befores leave the pool
  // immediately so they cannot pair twice.
  const exactPairs = [];
  for (const sameSectionOnly of [true, false]) {
    for (const [b, a] of matchByText(beforePool, afterPool, sameSectionOnly)) {
      exactPairs.push([b, a]);
      beforePool.splice(beforePool.indexOf(b), 1);
    }
  }
  for (const [b, a] of exactPairs) {
    if (b.section !== a.section || b.path !== a.path) {
      moved.push({
        section: a.section,
        path: a.path,
        text: a.text,
        before: { section: b.section, path: b.path },
        after: { section: a.section, path: a.path },
      });
    }
    if (b.checked !== undefined && a.checked !== undefined && b.checked !== a.checked) {
      taskStateChanged.push({
        section: a.section,
        path: a.path,
        text: a.text,
        task: { before: b.checked, after: a.checked },
      });
    }
  }

  // Pass 2: same-section, same-depth positional pairing → edits.
  const edited = [];
  const removed = [];
  const added = [];
  for (const b of beforePool) {
    const idx = afterPool.findIndex((a) => a.section === b.section && a.depth === b.depth);
    if (idx === -1) {
      removed.push({ section: b.section, path: b.path, before: b.text });
      continue;
    }
    const a = afterPool.splice(idx, 1)[0];
    edited.push({ section: b.section, path: b.path, before: b.text, after: a.text });
    if (b.checked !== undefined && a.checked !== undefined && b.checked !== a.checked) {
      taskStateChanged.push({
        section: b.section,
        path: b.path,
        text: a.text,
        task: { before: b.checked, after: a.checked },
      });
    }
  }
  for (const a of afterPool) {
    added.push({ section: a.section, path: a.path, after: a.text });
  }

  return { added, removed, edited, moved, taskStateChanged };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function sanitizeText(value) {
  return typeof value === "string" ? filterSensitive(value) : value;
}

// Filter every text field individually — never the serialized JSON, where a
// redaction could consume a structural quote and corrupt the document.
function sanitizeEntry(entry) {
  const clean = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === "object") {
      clean[key] = sanitizeEntry(value);
    } else {
      clean[key] = sanitizeText(value);
    }
  }
  return clean;
}

function sanitizeModel(model) {
  const clean = {};
  for (const key of DIFF_CLASSES) clean[key] = model[key].map(sanitizeEntry);
  return clean;
}

/** Render the diff model as a stable JSON document (string). */
export function renderDiffJson(model, meta = {}) {
  const snapshot = meta.snapshotId
    ? { id: filterSensitive(String(meta.snapshotId)), captured_at: meta.capturedAt || null }
    : null;
  return JSON.stringify({ snapshot, ...sanitizeModel(model) }, null, 2);
}

/** Render the diff model as a Markdown report (string) for human review. */
export function renderDiffMarkdown(model, meta = {}) {
  const m = sanitizeModel(model);
  const counts = DIFF_CLASSES.map((key) => `${m[key].length} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`);
  const lines = ["# Context diff", ""];
  if (meta.snapshotId) {
    lines.push(`Compared against snapshot \`${filterSensitive(String(meta.snapshotId))}\`` +
      (meta.capturedAt ? ` (captured ${meta.capturedAt})` : "") + ".");
    lines.push("");
  }
  lines.push(`Summary: ${counts.join(", ")}.`, "");

  const section = (title, entries, render) => {
    lines.push(`## ${title} (${entries.length})`, "");
    if (entries.length === 0) lines.push("- (none)");
    for (const entry of entries) lines.push(render(entry));
    lines.push("");
  };

  section("Added", m.added, (e) => `- [${e.section}] ${e.after}`);
  section("Removed", m.removed, (e) => `- [${e.section}] ${e.before}`);
  section("Edited", m.edited, (e) => `- [${e.section}] ${e.before} → ${e.after}`);
  section("Moved", m.moved, (e) =>
    `- [${e.section}] ${e.text} (${e.before.section}: ${e.before.path} → ${e.after.section}: ${e.after.path})`);
  section("Task state changed", m.taskStateChanged, (e) =>
    `- [${e.section}] ${e.text} (${e.task.before ? "done" : "open"} → ${e.task.after ? "done" : "open"})`);

  if (DIFF_CLASSES.every((key) => m[key].length === 0)) {
    lines.push("No changes since the snapshot.", "");
  }
  return lines.join("\n");
}

// ── Command core ─────────────────────────────────────────────────────────────

function failure(error, guidance) {
  return { ok: false, error, guidance };
}

function parseSnapshot(raw, id) {
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new Error(`snapshot '${id}' is malformed: not valid JSON`);
  }
  if (!snapshot || typeof snapshot !== "object" || !snapshot.state || typeof snapshot.state !== "object") {
    throw new Error(`snapshot '${id}' is malformed: missing state`);
  }
  return snapshot;
}

/**
 * Report whether a snapshot file's content digest equals `digest`. The
 * stored digest is trusted when present and recomputed otherwise; an
 * unreadable or malformed snapshot never matches (it is picked as-is and
 * surfaces its own parse error later).
 */
async function snapshotMatchesDigest(io, snapshotsDir, name, digest) {
  try {
    const snapshot = JSON.parse(await io.readFile(`${snapshotsDir}/${name}`));
    if (snapshot && typeof snapshot.digest === "string") return snapshot.digest === digest;
    if (snapshot && snapshot.state) return snapshotDigest(snapshot.state) === digest;
  } catch {
    // Fall through: not a match.
  }
  return false;
}

/**
 * Run `/handoff diff` against an injected filesystem.
 *
 * `paths`: { handoffDir }.
 * `options.from`: a snapshot id, or "latest" for the literal newest snapshot.
 *   When omitted, the default baseline is the previous semantic snapshot:
 *   the newest snapshot unless its digest equals the current state's digest
 *   (save → diff), in which case the snapshot before it is used;
 * `options.format`: "markdown" (default) or "json".
 * `io`: { readFile(path), listDir(path) } — read-only; nothing is ever
 * written, renamed, or removed.
 *
 * Returns { ok, output, model, snapshot, format } or { ok: false, error }.
 */
async function runV2Diff(paths, io, options = {}) {
  if (!paths || !paths.handoffDir) throw new Error("runDiff requires paths.handoffDir");
  if (!io) throw new Error("runDiff requires an io adapter");

  const format = options.format || "markdown";
  if (!DIFF_FORMATS.includes(format)) {
    return failure(`unknown format '${format}'; expected one of: ${DIFF_FORMATS.join(", ")}`);
  }

  let mapRaw;
  try {
    mapRaw = await io.readFile(`${paths.handoffDir}/${CONTEXT_MAP_FILE}`);
  } catch {
    return failure(`could not read ${CONTEXT_MAP_FILE} in ${paths.handoffDir}`);
  }
  const current = buildSnapshot(parseContextMap(mapRaw));

  const snapshotsDir = `${paths.handoffDir}/${SNAPSHOT_DIR}`;
  const names = ((await io.listDir(snapshotsDir)) || []).filter((name) => SNAPSHOT_FILE_RE.test(name)).sort();

  const from = options.from;
  let id;
  if (from === undefined) {
    // Default baseline: the previous SEMANTIC snapshot. When the newest
    // snapshot's digest equals the current state's digest (the usual
    // save → diff sequence), comparing against it would always report
    // "no changes", so the snapshot before it becomes the baseline. When
    // the map drifted since the last save, the newest snapshot differs
    // from the current state and stays the baseline.
    if (names.length === 0) {
      return failure(
        "no semantic snapshots found",
        "Run `/handoff save` at least once to record a snapshot before diffing."
      );
    }
    const currentDigest = snapshotDigest(current);
    let pick = names.length - 1;
    if (await snapshotMatchesDigest(io, snapshotsDir, names[pick], currentDigest)) {
      pick -= 1;
    }
    if (pick < 0) {
      return failure(
        "no earlier snapshot to compare against: the newest snapshot already matches the current state",
        "Use --from latest to compare against the newest snapshot anyway, or make a change and run `/handoff save` first."
      );
    }
    id = names[pick].replace(/\.json$/, "");
  } else if (from === "latest") {
    // Explicit --from latest is literal: the newest snapshot, even when it
    // equals the current state.
    if (names.length === 0) {
      return failure(
        "no semantic snapshots found",
        "Run `/handoff save` at least once to record a snapshot before diffing."
      );
    }
    id = names.at(-1).replace(/\.json$/, "");
  } else {
    if (!SNAPSHOT_ID_RE.test(from)) {
      return failure(`invalid snapshot id '${from}'`, "Snapshot ids look like 2026-07-28T00-00-00-000Z-abcdef12.");
    }
    if (!names.includes(`${from}.json`)) {
      return failure(`unknown snapshot '${from}'`, "Run `/handoff save` to record snapshots, or use --from latest.");
    }
    id = from;
  }

  let snapshot;
  try {
    snapshot = parseSnapshot(await io.readFile(`${snapshotsDir}/${id}.json`), id);
  } catch (err) {
    return failure(err.message);
  }

  const model = diffStates(snapshot.state, current);
  const meta = { snapshotId: id, capturedAt: snapshot.captured_at || null };
  const output = format === "json" ? renderDiffJson(model, meta) : renderDiffMarkdown(model, meta);
  return { ok: true, output, model, format, snapshot: { id, captured_at: meta.capturedAt } };
}

// ── v3 stable-ID semantic diff ───────────────────────────────────────────────
// v3 snapshots normalize the complete canonical state (directory + bodies),
// so the v3 diff matches nodes by stable ID and splits changes into precise
// categories: added, deleted, moved (section/parent), labelEdited,
// summaryEdited, bodyEdited, taskStateChanged, and attributesChanged
// (priority/severity).

import { V3_SECTION_KEYS } from "./context-map.mjs";
import { loadHandoffState } from "./handoff-state.mjs";
import { buildV3Snapshot, v3SnapshotDigest } from "./snapshots.mjs";
import { CONTENT_DIR } from "./content-files.mjs";

/** Stable v3 diff categories, in reporting order. */
export const V3_DIFF_CLASSES = [
  "added",
  "deleted",
  "moved",
  "labelEdited",
  "summaryEdited",
  "bodyEdited",
  "taskStateChanged",
  "attributesChanged",
];

/**
 * Diff two normalized v3 snapshot states (`buildV3Snapshot` outputs) by
 * stable node ID. A node may appear in several categories (e.g. labelEdited
 * and bodyEdited); moves are reported once and never as add+delete.
 */
export function diffV3States(beforeState, afterState) {
  const model = {};
  for (const key of V3_DIFF_CLASSES) model[key] = [];

  const before = new Map(((beforeState && beforeState.nodes) || []).map((n) => [n.id, n]));
  const after = new Map(((afterState && afterState.nodes) || []).map((n) => [n.id, n]));

  for (const [id, node] of after) {
    if (!before.has(id)) {
      model.added.push({ id, section: node.section, after: node.label });
    }
  }
  for (const [id, node] of before) {
    if (!after.has(id)) {
      model.deleted.push({ id, section: node.section, before: node.label });
    }
  }
  for (const [id, bn] of before) {
    const an = after.get(id);
    if (!an) continue;
    if (bn.section !== an.section || (bn.parentId ?? null) !== (an.parentId ?? null)) {
      model.moved.push({
        id,
        text: an.label,
        before: { section: bn.section, parentId: bn.parentId ?? null },
        after: { section: an.section, parentId: an.parentId ?? null },
      });
    }
    if (bn.label !== an.label) {
      model.labelEdited.push({ id, section: an.section, before: bn.label, after: an.label });
    }
    if ((bn.summary ?? "") !== (an.summary ?? "")) {
      model.summaryEdited.push({ id, section: an.section, before: bn.summary ?? "", after: an.summary ?? "" });
    }
    if ((bn.body ?? "") !== (an.body ?? "")) {
      model.bodyEdited.push({ id, section: an.section, before: bn.body ?? "", after: an.body ?? "" });
    }
    if ((bn.taskState ?? null) !== (an.taskState ?? null)) {
      model.taskStateChanged.push({
        id,
        section: an.section,
        text: an.label,
        task: { before: !!bn.taskState, after: !!an.taskState },
      });
    }
    if ((bn.priority ?? null) !== (an.priority ?? null) || (bn.severity ?? null) !== (an.severity ?? null)) {
      model.attributesChanged.push({
        id,
        section: an.section,
        text: an.label,
        before: { priority: bn.priority ?? null, severity: bn.severity ?? null },
        after: { priority: an.priority ?? null, severity: an.severity ?? null },
      });
    }
  }
  return model;
}

// Filter every text field individually (reusing the v2 field-by-field
// sanitizer) — never the serialized JSON, where a redaction could consume a
// structural quote and corrupt the document.
function sanitizeV3Model(model) {
  const clean = {};
  for (const key of V3_DIFF_CLASSES) {
    clean[key] = (model[key] || []).map(sanitizeEntry);
  }
  return clean;
}

/** Render the v3 diff model as stable JSON (string). */
export function renderV3DiffJson(model, meta = {}) {
  const snapshot = meta.snapshotId
    ? { id: filterSensitive(String(meta.snapshotId)), captured_at: meta.capturedAt || null }
    : null;
  return JSON.stringify({ snapshot, ...sanitizeV3Model(model) }, null, 2);
}

/** Render the v3 diff model as a Markdown report (string) for human review. */
export function renderV3DiffMarkdown(model, meta = {}) {
  const m = sanitizeV3Model(model);
  const counts = V3_DIFF_CLASSES.map((key) => `${m[key].length} ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`);
  const lines = ["# Context diff", ""];
  if (meta.snapshotId) {
    lines.push(`Compared against snapshot \`${filterSensitive(String(meta.snapshotId))}\`` +
      (meta.capturedAt ? ` (captured ${meta.capturedAt})` : "") + ".");
    lines.push("");
  }
  lines.push(`Summary: ${counts.join(", ")}.`, "");

  const section = (title, entries, render) => {
    lines.push(`## ${title} (${entries.length})`, "");
    if (entries.length === 0) lines.push("- (none)");
    for (const entry of entries) lines.push(render(entry));
    lines.push("");
  };

  section("Added", m.added, (e) => `- [${e.section}] \`${e.id}\` ${e.after}`);
  section("Deleted", m.deleted, (e) => `- [${e.section}] \`${e.id}\` ${e.before}`);
  section("Moved", m.moved, (e) =>
    `- \`${e.id}\` ${e.text} (${e.before.section}/${e.before.parentId ?? "-"} → ${e.after.section}/${e.after.parentId ?? "-"})`);
  section("Label edited", m.labelEdited, (e) => `- [${e.section}] \`${e.id}\` ${e.before} → ${e.after}`);
  section("Summary edited", m.summaryEdited, (e) => `- [${e.section}] \`${e.id}\` ${e.before} → ${e.after}`);
  section("Body edited", m.bodyEdited, (e) => `- [${e.section}] \`${e.id}\` body changed`);
  section("Task state changed", m.taskStateChanged, (e) =>
    `- [${e.section}] \`${e.id}\` ${e.text} (${e.task.before ? "done" : "open"} → ${e.task.after ? "done" : "open"})`);
  section("Attributes changed", m.attributesChanged, (e) =>
    `- [${e.section}] \`${e.id}\` ${e.text} (priority ${e.before.priority ?? "-"} → ${e.after.priority ?? "-"}, severity ${e.before.severity ?? "-"} → ${e.after.severity ?? "-"})`);

  if (V3_DIFF_CLASSES.every((key) => m[key].length === 0)) {
    lines.push("No changes since the snapshot.", "");
  }
  return lines.join("\n");
}

/** True when a snapshot file carries a v3 normalized state. */
function isV3Snapshot(snapshot) {
  return !!(snapshot && snapshot.state && Array.isArray(snapshot.state.nodes));
}

/**
 * Run `/handoff diff` against a v3 layout. Same baseline-selection contract
 * as the v2 path; v2 snapshots (state.sections) are never eligible v3
 * baselines. Strictly read-only.
 */
async function runV3Diff(paths, io, options, format) {
  let state;
  try {
    state = await loadHandoffState(io, paths.handoffDir);
  } catch (err) {
    return failure(`could not load the v3 handoff state: ${err.message}`);
  }
  const current = buildV3Snapshot(state);
  const currentDigest = v3SnapshotDigest(current);

  const snapshotsDir = `${paths.handoffDir}/${SNAPSHOT_DIR}`;
  const allNames = ((await io.listDir(snapshotsDir)) || []).filter((name) => SNAPSHOT_FILE_RE.test(name)).sort();

  // Only v3 snapshots (state.nodes) are eligible baselines.
  const names = [];
  for (const name of allNames) {
    try {
      const parsed = JSON.parse(await io.readFile(`${snapshotsDir}/${name}`));
      if (isV3Snapshot(parsed)) names.push(name);
    } catch {
      // Unreadable snapshots are skipped as baselines.
    }
  }

  const noBaseline = () => failure(
    "no v3 semantic snapshots found",
    "Run `/handoff save` at least once to record a v3 snapshot before diffing."
  );

  const from = options.from;
  let id;
  if (from === undefined) {
    if (names.length === 0) return noBaseline();
    let pick = names.length - 1;
    try {
      const latest = JSON.parse(await io.readFile(`${snapshotsDir}/${names[pick]}`));
      const digest = typeof latest.digest === "string" ? latest.digest : v3SnapshotDigest(latest.state);
      if (digest === currentDigest) pick -= 1;
    } catch {
      // Fall through: the newest snapshot stays the baseline.
    }
    if (pick < 0) {
      return failure(
        "no earlier snapshot to compare against: the newest snapshot already matches the current state",
        "Use --from latest to compare against the newest snapshot anyway, or make a change and run `/handoff save` first."
      );
    }
    id = names[pick].replace(/\.json$/, "");
  } else if (from === "latest") {
    if (names.length === 0) return noBaseline();
    id = names.at(-1).replace(/\.json$/, "");
  } else {
    if (!SNAPSHOT_ID_RE.test(from)) {
      return failure(`invalid snapshot id '${from}'`, "Snapshot ids look like 2026-08-02T00-00-00-000Z-abcdef12.");
    }
    if (!names.includes(`${from}.json`)) {
      return failure(`unknown snapshot '${from}'`, "Run `/handoff save` to record snapshots, or use --from latest.");
    }
    id = from;
  }

  let snapshot;
  try {
    snapshot = parseSnapshot(await io.readFile(`${snapshotsDir}/${id}.json`), id);
  } catch (err) {
    return failure(err.message);
  }

  const model = diffV3States(snapshot.state, current);
  const meta = { snapshotId: id, capturedAt: snapshot.captured_at || null };
  const output = format === "json" ? renderV3DiffJson(model, meta) : renderV3DiffMarkdown(model, meta);
  return { ok: true, output, model, format, snapshot: { id, captured_at: meta.capturedAt } };
}

/**
 * Run `/handoff diff`: routes to the v3 stable-ID diff when the layout
 * carries content/ files, otherwise to the legacy v2 content-matching diff.
 * Strictly read-only in both paths.
 */
export async function runDiff(paths, io, options = {}) {
  if (!paths || !paths.handoffDir) throw new Error("runDiff requires paths.handoffDir");
  if (!io) throw new Error("runDiff requires an io adapter");
  const format = options.format || "markdown";
  if (!DIFF_FORMATS.includes(format)) {
    return failure(`unknown format '${format}'; expected one of: ${DIFF_FORMATS.join(", ")}`);
  }
  let top = [];
  try {
    top = await io.listDir(paths.handoffDir);
  } catch {
    // Missing handoff dir: let the v2 path report the unreadable map.
  }
  if (top.includes(CONTENT_DIR)) {
    return runV3Diff(paths, io, options, format);
  }
  return runV2Diff(paths, io, options);
}

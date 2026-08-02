// @ts-nocheck
/**
 * Handoff Protocol v2.3 — Semantic snapshots (shared module).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/save.ts) and the Node.js implementation (scripts/node/save.mjs).
 * It intentionally uses no runtime-specific APIs (no `Deno.*`, no `node:*`):
 * writeSnapshot performs all filesystem work through an injected `io`
 * adapter, so behavior stays identical across runtimes and is testable with
 * an in-memory filesystem.
 *
 * Snapshot contract
 * -----------------
 * Every successful `/handoff save` records the semantic state of the
 * canonical Context Map as normalized, sanitized JSON under
 * `.handoff/history/snapshots/`. Normalization works from the parsed map:
 * sections are keyed by their fixed semantic keys (never by localized
 * headings) and generated agent markers/fingerprints are stripped, so two
 * saves that differ only in rendering carry the same semantic digest.
 *
 * A snapshot is written only when the semantic state changes: the digest of
 * the new state is compared against the digest of the newest existing
 * snapshot, and an identical state is a no-op. Snapshot IDs combine a UTC
 * timestamp with a short content digest, so distinct states can never
 * collide even under clock skew. Retention keeps the latest 20 snapshots by
 * default; cleanup only ever removes files matching the snapshot pattern
 * inside the snapshots directory — migration backups under
 * `history/migrations/` and any non-snapshot files are never touched.
 */

import {
  PROTOCOL_VERSION,
  SECTION_KEYS,
  filterSensitive,
} from "./context-map.mjs";
import { sha256Hex } from "./views.mjs";

/** Snapshots live under .handoff/history/snapshots/ (relative to .handoff). */
export const SNAPSHOT_DIR = "history/snapshots";
/** Default number of snapshots retained. */
export const SNAPSHOT_RETENTION = 20;
/** Snapshot file names: <sanitized-UTC-timestamp>-<8-hex-digest>.json */
export const SNAPSHOT_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/;

/** Strip generated agent markers/fingerprints and surrounding HTML comments. */
function stripGenerated(text) {
  return String(text)
    .replace(/<!--\s*agent-hash:[0-9a-f]{8}\s*-->/gi, "")
    .replace(/<!--\s*agent\s*-->/gi, "")
    .trim();
}

/**
 * Build the normalized semantic state for a parsed Context Map.
 *
 * Sections are emitted in the fixed SECTION_KEYS order under their semantic
 * keys, each node reduced to { text, checked?, depth, origin } with generated
 * fingerprints stripped and the sensitive-data filter applied. Unknown
 * sections (extras) are preserved as sanitized heading/body pairs. The result
 * is deterministic: identical semantic maps always build identical states,
 * regardless of localized headings or rendering.
 */
export function buildSnapshot(map) {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = ((map && map.sections && map.sections[key]) || []).map((node) => {
      const out = {
        text: filterSensitive(stripGenerated(node.text)),
        depth: Math.max(0, Number(node.depth) || 0),
        origin: node.origin === "agent" ? "agent" : "user",
      };
      if (key === "tasks") out.checked = !!node.checked;
      return out;
    });
  }
  const extras = ((map && map.extras) || []).map((extra) => ({
    heading: filterSensitive(String(extra.heading)),
    body: extra.body.map((line) => filterSensitive(String(line))),
  }));
  return { sections, extras };
}

/** Short content digest of a normalized snapshot state (8 hex chars). */
export function snapshotDigest(state) {
  return sha256Hex(JSON.stringify(state)).slice(0, 8);
}

function sanitizeTimestamp(timestamp) {
  return String(timestamp).replace(/[:.]/g, "-");
}

/**
 * Write a semantic snapshot of a parsed Context Map, when the state changed.
 *
 * `paths`: { handoffDir }.
 * `io`: runtime-injected filesystem adapter —
 *   { readFile(path), writeFile(path, content), mkdir(path),
 *     listDir(path), remove(path) } (all may be async; listDir returns entry
 *   names and may return [] for a missing directory).
 * `options.timestamp` fixes the snapshot ID (defaults to the current UTC
 * time); `options.retention` overrides SNAPSHOT_RETENTION.
 *
 * Returns `{ written, digest, path?, reason? }`. An unchanged state reports
 * `{ written: false, reason: "unchanged" }` and performs no writes. After a
 * write, snapshots beyond the retention limit are pruned oldest-first; only
 * files matching SNAPSHOT_FILE_RE inside the snapshots directory are ever
 * removed.
 */
export async function writeSnapshot(map, paths, io, options = {}) {
  if (!paths || !paths.handoffDir) throw new Error("writeSnapshot requires paths.handoffDir");
  if (!io) throw new Error("writeSnapshot requires an io adapter");

  const state = buildSnapshot(map);
  const digest = snapshotDigest(state);
  const retention = Math.max(1, Number(options.retention) || SNAPSHOT_RETENTION);
  const snapshotsDir = `${paths.handoffDir}/${SNAPSHOT_DIR}`;

  // Skip the write when the newest snapshot already carries this state.
  const existing = (await io.listDir(snapshotsDir)).filter((name) => SNAPSHOT_FILE_RE.test(name)).sort();
  const newest = existing.at(-1);
  if (newest) {
    try {
      const latest = JSON.parse(await io.readFile(`${snapshotsDir}/${newest}`));
      if (latest && latest.digest === digest) {
        return { written: false, digest, reason: "unchanged" };
      }
    } catch {
      // Unreadable newest snapshot: fall through and write a fresh one.
    }
  }

  const timestamp = options.timestamp || new Date().toISOString();
  const path = `${snapshotsDir}/${sanitizeTimestamp(timestamp)}-${digest}.json`;
  const snapshot = { version: PROTOCOL_VERSION, captured_at: timestamp, digest, state };
  await io.mkdir(snapshotsDir);
  await io.writeFile(path, JSON.stringify(snapshot, null, 2));

  // Retention: prune the oldest snapshots, snapshot-pattern files only.
  const names = [...existing.filter((name) => name !== path.split("/").pop()), path.split("/").pop()].sort();
  for (const stale of names.slice(0, Math.max(0, names.length - retention))) {
    await io.remove(`${snapshotsDir}/${stale}`);
  }

  return { written: true, digest, path };
}

// ── v3 semantic snapshots ────────────────────────────────────────────────────
// v3 snapshots normalize the complete canonical state: every node keeps its
// stable ID, section, parent linkage, document order, label, lightweight
// state (task state, priority, severity), summary, and complete body — after
// sensitive-data filtering and ownership-fingerprint stripping.

import {
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
} from "./context-map.mjs";

function v3BodyFor(content, key, id) {
  for (const entry of ((content && content[key]) || [])) {
    if (entry.id === id) return entry;
  }
  return null;
}

/**
 * Build the normalized v3 semantic state: `{ nodes, extras }` where each node
 * is `{ id, section, parentId, order, label, taskState?, priority?,
 * severity?, summary, body, origin }`. Deterministic: identical canonical
 * states always build identical snapshots.
 */
export function buildV3Snapshot(state) {
  const nodes = [];
  const map = (state && state.map) || { sections: {}, extras: [] };
  const content = (state && state.content) || {};
  for (const key of V3_SECTION_KEYS) {
    const stack = [];
    ((map.sections && map.sections[key]) || []).forEach((node, order) => {
      const depth = Math.max(0, Number(node.depth) || 0);
      const parentId = depth > 0 ? stack[depth - 1] ?? null : null;
      stack[depth] = node.id;
      stack.length = depth + 1;
      const entry = node.id != null ? v3BodyFor(content, key, node.id) : null;
      const out = {
        id: node.id ?? null,
        section: key,
        parentId,
        order,
        label: filterSensitive(stripGenerated(node.label)),
        origin: node.origin === "agent" ? "agent" : "user",
        summary: entry ? filterSensitive(stripGenerated(entry.summary)) : "",
        body: entry ? filterSensitive(stripGenerated(entry.body)) : "",
      };
      if (key === "tasks") out.taskState = !!node.checked;
      if (node.priority) out.priority = node.priority;
      if (node.severity) out.severity = node.severity;
      nodes.push(out);
    });
    // Orphan bodies (no Map node) are part of the semantic state.
    for (const entry of content[key] || []) {
      if (nodes.some((n) => n.section === key && n.id === entry.id)) continue;
      nodes.push({
        id: entry.id,
        section: key,
        parentId: null,
        order: -1,
        label: "",
        origin: entry.origin === "agent" ? "agent" : "user",
        summary: filterSensitive(stripGenerated(entry.summary)),
        body: filterSensitive(stripGenerated(entry.body)),
        orphan: true,
      });
    }
  }
  const extras = ((map && map.extras) || []).map((extra) => ({
    heading: filterSensitive(String(extra.heading)),
    body: extra.body.map((line) => filterSensitive(String(line))),
  }));
  return { nodes, extras };
}

/** Short content digest of a normalized v3 snapshot state (8 hex chars). */
export function v3SnapshotDigest(state) {
  return sha256Hex(`${V3_PROTOCOL_VERSION}\n${JSON.stringify(state)}`).slice(0, 8);
}

/**
 * Write a v3 semantic snapshot when the semantic state changed. Same
 * contract as writeSnapshot: `{ written, digest, path?, reason? }`, newest
 * digest comparison, retention pruning of snapshot-pattern files only.
 */
export async function writeV3Snapshot(state, paths, io, options = {}) {
  if (!paths || !paths.handoffDir) throw new Error("writeV3Snapshot requires paths.handoffDir");
  if (!io) throw new Error("writeV3Snapshot requires an io adapter");

  const snapshot = buildV3Snapshot(state);
  const digest = v3SnapshotDigest(snapshot);
  const retention = Math.max(1, Number(options.retention) || SNAPSHOT_RETENTION);
  const snapshotsDir = `${paths.handoffDir}/${SNAPSHOT_DIR}`;

  const existing = (await io.listDir(snapshotsDir)).filter((name) => SNAPSHOT_FILE_RE.test(name)).sort();
  const newest = existing.at(-1);
  if (newest) {
    try {
      const latest = JSON.parse(await io.readFile(`${snapshotsDir}/${newest}`));
      if (latest && latest.digest === digest) {
        return { written: false, digest, reason: "unchanged" };
      }
    } catch {
      // Unreadable newest snapshot: fall through and write a fresh one.
    }
  }

  const timestamp = options.timestamp || new Date().toISOString();
  const path = `${snapshotsDir}/${sanitizeTimestamp(timestamp)}-${digest}.json`;
  const payload = { version: V3_PROTOCOL_VERSION, captured_at: timestamp, digest, state: snapshot };
  await io.mkdir(snapshotsDir);
  await io.writeFile(path, JSON.stringify(payload, null, 2));

  const names = [...existing.filter((name) => name !== path.split("/").pop()), path.split("/").pop()].sort();
  for (const stale of names.slice(0, Math.max(0, names.length - retention))) {
    await io.remove(`${snapshotsDir}/${stale}`);
  }

  return { written: true, digest, path };
}

// @ts-nocheck
/**
 * Handoff Protocol v3 — canonical handoff state.
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno and Node.js
 * implementations (no `Deno.*`, no `node:*`). It joins the two canonical v3
 * layers into one in-memory state:
 *
 *   - `context-map.md`  — the directory: stable IDs, labels, hierarchy, task
 *                         state, and compact metadata (priority/severity).
 *   - `content/*.md`    — the bodies: one entry per node ID, holding the
 *                         required first-paragraph summary and the verbatim
 *                         detail body. Labels are NOT duplicated here.
 *
 * Integrity model
 * ---------------
 * Hard failures (loadHandoffState throws with actionable diagnostics):
 *   - missing or unreadable Context Map;
 *   - missing required content files;
 *   - invalid, unknown, or duplicate Map IDs (ID_INVALID / ID_DUPLICATE);
 *   - one ID in multiple body files (CONTENT_DUPLICATE);
 *   - a body entry whose file section contradicts the Map (CONTENT_MISPLACED).
 *
 * Soft diagnostics (returned in state.diagnostics, load still succeeds):
 *   - CONTENT_MISSING         — Map ID has no body entry;
 *   - CONTENT_ORPHAN          — body entry not referenced by the Map (retained);
 *   - CONTENT_SUMMARY_MISSING — non-empty body without a summary paragraph.
 *
 * A node legitimately moved to another section keeps its historical ID (and
 * prefix); its body then lives in the body file of its CURRENT section, so a
 * prefix/file mismatch alone is not an error — only a contradiction with the
 * Map is.
 */

import {
  AGENT_MARKER,
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
  V3_SECTION_LABELS,
  nodeFingerprint,
  parseContextMapV3,
} from "./context-map.mjs";
import {
  CONTENT_DIR,
  CONTENT_FILES,
  ID_PREFIXES,
} from "./content-files.mjs";

/** Short-ID grammar: section-derived prefix + positive integer (no zero pad). */
export const NODE_ID_RE = /^(goal|status|task|decision|question|risk|note|excluded)([1-9][0-9]*)$/;

const AGENT_HASH_RE = /<!--\s*agent-hash:([0-9a-f]{8})\s*-->\s*$/i;
const ENTRY_HEADING_RE = /^##\s+(\S+)(.*?)\s*$/;

function entryFingerprint(entry) {
  return nodeFingerprint(`${entry.summary || ""}\n\n${entry.body || ""}`);
}

// ── Content-file parsing ─────────────────────────────────────────────────────

/**
 * Parse one section content file into entries:
 * `[{ id, summary, body, origin }]`. The first non-empty paragraph after an
 * ID heading is the summary (unless it is itself a heading, in which case the
 * entry has no summary and everything is body). Remaining Markdown is
 * preserved verbatim as the body.
 */
export function parseContentFile(markdown, sectionKey) {
  const entries = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
    let summary = "";
    let body = "";
    if (raw) {
      const blocks = raw.split(/\n{2,}/);
      if (blocks[0].trimStart().startsWith("#")) {
        body = raw;
      } else {
        summary = blocks[0].trim();
        body = blocks.slice(1).join("\n\n").replace(/\s+$/, "");
      }
    }
    const entry = { id: current.id, summary, body, origin: "user" };
    if (
      current.agentMarker &&
      (!current.storedHash || current.storedHash === entryFingerprint(entry))
    ) {
      entry.origin = "agent";
    }
    entries.push(entry);
    current = null;
  };

  for (const rawLine of String(markdown || "").split("\n")) {
    const trimmed = rawLine.trim();
    if (!current) {
      // Preamble: title, comments, and blank lines before the first entry.
      if (!trimmed || /^#\s/.test(trimmed) || /^<!--[\s\S]*-->\s*$/.test(trimmed)) continue;
      const heading = trimmed.match(ENTRY_HEADING_RE);
      if (heading && !trimmed.startsWith("###")) {
        let rest = heading[2];
        let storedHash = null;
        const hashMatch = rest.match(AGENT_HASH_RE);
        if (hashMatch) {
          storedHash = hashMatch[1].toLowerCase();
          rest = rest.replace(AGENT_HASH_RE, "").trim();
        }
        const agentMarker = /<!--\s*agent\s*-->\s*$/.test(rest);
        current = { id: heading[1], storedHash, agentMarker, lines: [] };
      }
      continue;
    }

    const heading = trimmed.match(ENTRY_HEADING_RE);
    if (heading && !trimmed.startsWith("###")) {
      flush();
      let rest = heading[2];
      let storedHash = null;
      const hashMatch = rest.match(AGENT_HASH_RE);
      if (hashMatch) {
        storedHash = hashMatch[1].toLowerCase();
        rest = rest.replace(AGENT_HASH_RE, "").trim();
      }
      const agentMarker = /<!--\s*agent\s*-->\s*$/.test(rest);
      current = { id: heading[1], storedHash, agentMarker, lines: [] };
      continue;
    }
    current.lines.push(rawLine.replace(/\s+$/, ""));
  }
  flush();
  return entries;
}

/** Render a section content file deterministically from its entries. */
export function renderContentFile(sectionKey, entries) {
  const label = (V3_SECTION_LABELS[sectionKey] || {}).en || sectionKey;
  const chunks = [`# ${label}`];
  for (const entry of entries || []) {
    let heading = `## ${entry.id}`;
    if (entry.origin === "agent") {
      heading += ` ${AGENT_MARKER} <!-- agent-hash:${entryFingerprint(entry)} -->`;
    }
    const parts = [heading];
    if (entry.summary) parts.push(entry.summary);
    if (entry.body) parts.push(entry.body);
    chunks.push(parts.join("\n\n"));
  }
  return chunks.join("\n\n") + "\n";
}

// ── Directory indexing ───────────────────────────────────────────────────────

/**
 * Index a parsed v3 Context Map by node ID. Returns:
 * `{ byId: Map<id, { sectionKey, node }>, duplicates: [id], invalid: [id] }`.
 * Nodes without an ID yet (user drafts pending allocation) are skipped.
 */
export function indexContextMap(map) {
  const byId = new Map();
  const duplicates = [];
  const invalid = [];
  for (const key of V3_SECTION_KEYS) {
    for (const node of (map && map.sections && map.sections[key]) || []) {
      if (node.id == null) continue;
      if (!NODE_ID_RE.test(node.id)) {
        invalid.push(node.id);
        continue;
      }
      if (byId.has(node.id)) {
        duplicates.push(node.id);
        continue;
      }
      byId.set(node.id, { sectionKey: key, node });
    }
  }
  return { byId, duplicates, invalid };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Soft integrity diagnostics for a loaded v3 state `{ map, content }`.
 * Never throws; structural failures are the loader's job.
 */
export function validateHandoffState(state) {
  const diagnostics = [];
  const index = indexContextMap(state.map);
  const bodyIds = new Set();
  for (const key of V3_SECTION_KEYS) {
    for (const entry of (state.content && state.content[key]) || []) {
      bodyIds.add(entry.id);
    }
  }

  for (const [id, loc] of index.byId) {
    if (!bodyIds.has(id)) {
      diagnostics.push(
        `CONTENT_MISSING: '${id}' has no body entry in ${CONTENT_DIR}/${CONTENT_FILES[loc.sectionKey]}`
      );
    }
  }

  for (const key of V3_SECTION_KEYS) {
    for (const entry of (state.content && state.content[key]) || []) {
      if (!index.byId.has(entry.id)) {
        diagnostics.push(
          `CONTENT_ORPHAN: '${entry.id}' in ${CONTENT_DIR}/${CONTENT_FILES[key]} is not referenced by the Context Map`
        );
      }
      const hasBody = !!(entry.body && entry.body.trim());
      const hasSummary = !!(entry.summary && entry.summary.trim());
      if (hasBody && !hasSummary) {
        diagnostics.push(
          `CONTENT_SUMMARY_MISSING: '${entry.id}' in ${CONTENT_DIR}/${CONTENT_FILES[key]} has a body but no first-paragraph summary`
        );
      }
    }
  }
  return diagnostics;
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function readOrNull(io, path) {
  try {
    return await io.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Load the canonical v3 handoff state from a handoff directory.
 * `io` needs only `readFile(path) -> Promise<string>`.
 *
 * Returns `{ version, map, content, diagnostics }` where `content` maps each
 * section key to its parsed entries. Throws an Error with actionable
 * diagnostics on structural failures (see the module header).
 */
export async function loadHandoffState(io, handoffDir) {
  const dir = String(handoffDir).replace(/\/+$/, "");

  const mapRaw = await readOrNull(io, `${dir}/context-map.md`);
  const map = mapRaw ? parseContextMapV3(mapRaw) : null;
  if (!map) {
    throw new Error(
      `missing or unreadable Context Map at ${dir}/context-map.md — run /handoff save to (re)create the v3 layout`
    );
  }

  const content = {};
  const missingFiles = [];
  for (const key of V3_SECTION_KEYS) {
    const name = CONTENT_FILES[key];
    const raw = await readOrNull(io, `${dir}/${CONTENT_DIR}/${name}`);
    if (raw == null) {
      missingFiles.push(`${CONTENT_DIR}/${name}`);
    } else {
      content[key] = parseContentFile(raw, key);
    }
  }
  if (missingFiles.length > 0) {
    throw new Error(
      `missing required content file(s): ${missingFiles.join(", ")} — the v3 layout needs all eight section files; run /handoff save to regenerate them`
    );
  }

  const errors = [];
  const index = indexContextMap(map);
  for (const id of index.invalid) {
    errors.push(
      `ID_INVALID: '${id}' in context-map.md does not match the short-ID grammar (e.g. goal1, task2)`
    );
  }
  for (const id of index.duplicates) {
    errors.push(`ID_DUPLICATE: '${id}' appears more than once in context-map.md`);
  }

  const bodyIndex = new Map(); // id -> section key of its body file
  for (const key of V3_SECTION_KEYS) {
    for (const entry of content[key]) {
      if (!NODE_ID_RE.test(entry.id)) {
        errors.push(
          `ID_INVALID: '${entry.id}' in ${CONTENT_DIR}/${CONTENT_FILES[key]} does not match the short-ID grammar (e.g. goal1, task2)`
        );
        continue;
      }
      if (bodyIndex.has(entry.id)) {
        errors.push(
          `CONTENT_DUPLICATE: '${entry.id}' appears in both ${CONTENT_DIR}/${CONTENT_FILES[bodyIndex.get(entry.id)]} and ${CONTENT_DIR}/${CONTENT_FILES[key]} — the loader cannot guess which body wins`
        );
        continue;
      }
      bodyIndex.set(entry.id, key);

      const mapLoc = index.byId.get(entry.id);
      const prefix = entry.id.match(NODE_ID_RE)[1];
      const prefixMatchesFile = prefix === ID_PREFIXES[key];
      if (mapLoc && mapLoc.sectionKey !== key) {
        errors.push(
          `CONTENT_MISPLACED: body for '${entry.id}' lives in ${CONTENT_DIR}/${CONTENT_FILES[key]} but the Map places it in '${mapLoc.sectionKey}' (expected ${CONTENT_DIR}/${CONTENT_FILES[mapLoc.sectionKey]})`
        );
      } else if (!mapLoc && !prefixMatchesFile) {
        errors.push(
          `CONTENT_MISPLACED: '${entry.id}' in ${CONTENT_DIR}/${CONTENT_FILES[key]} has a '${prefix}' prefix that belongs to another section, and no Map node justifies the move`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid v3 handoff state in ${dir}:\n- ${errors.join("\n- ")}`);
  }

  const state = { version: V3_PROTOCOL_VERSION, map, content };
  state.diagnostics = validateHandoffState(state);
  return state;
}

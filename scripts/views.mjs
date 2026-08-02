// @ts-nocheck
/**
 * Handoff Protocol v2 — Generated compatibility views.
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/save.ts, scripts/load.ts) and the Node.js implementation
 * (scripts/node/save.mjs, scripts/node/load.mjs). It intentionally uses no
 * runtime-specific APIs (no `Deno.*`, no `node:*`) so behavior stays
 * identical across runtimes.
 *
 * Canonical state model
 * ---------------------
 * `.handoff/context-map.md` is the only writable source for semantic state.
 * `HANDOFF.md`, `tasks.md`, and `decisions.md` are deterministic views
 * generated from the map (plus save-time machine metadata) and are marked
 * with GENERATED_MARKER so users edit the map instead. `context.json` v2
 * carries no semantic fields at all — only protocol metadata, Git state,
 * SHA-256 hashes of the generated views, and migration/conflict
 * diagnostics. Loaders compare on-disk view hashes against the stored ones
 * to surface manual edits; those edits are never imported into the map.
 */

import {
  contextMapToContext,
  emptyContextMap,
  PROTOCOL_VERSION,
} from "./context-map.mjs";

/** First line of every generated view; tells users to edit the map instead. */
export const GENERATED_MARKER = "<!-- generated-from: context-map.md; do not edit -->";

// ── SHA-256 ──────────────────────────────────────────────────────────────────
// Pure-JS SHA-256 so view hashes are identical in Node and Deno without
// runtime-specific crypto imports.

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Hex SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// ── View rendering ───────────────────────────────────────────────────────────

function renderHandoffMd(semantics, metadata) {
  const git = metadata.git || {};
  const completed = (metadata.completed || []).map((item) => `- ${item}`).join("\n");
  const modified = (metadata.modifiedFiles || [])
    .map((f) => `- \`${f.path}\` [${f.change_type}]`)
    .join("\n");
  const blockers = (metadata.blockers || []).map((b) => `- ${b}`).join("\n");
  const nextSteps = (metadata.nextSteps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
  const todos = semantics.todos
    .map((t) => `- [${t.status === "completed" ? "x" : " "}] **${t.priority}** ${t.task}`)
    .join("\n");
  const risks = semantics.risks.map((r) => `- ${r}`).join("\n");

  return `${GENERATED_MARKER}

# Project Handoff

**Saved**: ${metadata.timestamp}
**Agent**: ${metadata.agent}
**Project**: ${metadata.project}
**Branch**: ${git.branch}
**Commit**: ${git.latest_commit} - ${git.commit_message}

## Current Goal

${semantics.current_goal || "No explicit goal set."}

## Current Status

${semantics.status || "unknown"}

## Completed Work

${completed || "No completed work recorded."}

## Modified Files

${modified || "No files modified."}

## Outstanding Issues

${blockers || "No blockers."}

## TODO

${todos || "No pending tasks."}

## Recommended Next Steps

${nextSteps || "No next steps defined."}

## Risks / Notes

${risks || "No risks identified."}

---

*Generated by Handoff Protocol v${PROTOCOL_VERSION}*
`;
}

function renderTasksMd(semantics) {
  const byPriority = (priority) => semantics.todos.filter((t) => t.priority === priority);
  const fmt = (tasks) =>
    tasks.map((t) => `- [${t.status === "completed" ? "x" : " "}] ${t.task}`).join("\n") || "None";

  return `${GENERATED_MARKER}

# Pending Tasks

## High Priority
${fmt(byPriority("high"))}

## Medium Priority
${fmt(byPriority("medium"))}

## Low Priority
${fmt(byPriority("low"))}
`;
}

function renderDecisionsMd(semantics) {
  if (semantics.decisions.length === 0) {
    return `${GENERATED_MARKER}\n\n# Architecture Decisions\n\nNo decisions recorded.\n`;
  }

  const decisions = semantics.decisions
    .map((d) => `## ${d.title || "Decision"}

- **Context**: ${d.context || "N/A"}
- **Decision**: ${d.decision}
- **Rationale**: ${d.rationale || "N/A"}`)
    .join("\n\n");

  return `${GENERATED_MARKER}\n\n# Architecture Decisions\n\n${decisions}\n`;
}

/**
 * Generate the compatibility views from a parsed Context Map.
 *
 * `map` is a parseContextMap result (null is treated as an empty map).
 * `metadata` carries save-time machine state:
 *   { timestamp, agent, project, lang, verbosity, git,
 *     completed, modifiedFiles, blockers, nextSteps }.
 * `options.verbosity === "low"` generates only HANDOFF.md, matching the
 * documented low-verbosity file set.
 *
 * Returns `{ "HANDOFF.md": string, "tasks.md"?: string, "decisions.md"?: string }`;
 * identical map + metadata + options always produce identical contents.
 */
export function generateViews(map, metadata = {}, options = {}) {
  const semantics = contextMapToContext(map || emptyContextMap());
  const views = { "HANDOFF.md": renderHandoffMd(semantics, metadata) };
  if (options.verbosity !== "low") {
    views["tasks.md"] = renderTasksMd(semantics);
    views["decisions.md"] = renderDecisionsMd(semantics);
  }
  return views;
}

// ── context.json v2 ──────────────────────────────────────────────────────────

/**
 * Build the v2 context.json object: protocol metadata, Git/environment state,
 * per-view SHA-256 hashes, and migration/conflict diagnostics. It carries no
 * semantic fields — the Context Map is the only semantic source.
 */
export function buildContextJson(metadata, viewHashes, diagnostics = {}) {
  return {
    version: PROTOCOL_VERSION,
    timestamp: metadata.timestamp,
    agent: metadata.agent,
    project: metadata.project,
    lang: metadata.lang,
    git: metadata.git,
    views: viewHashes || {},
    diagnostics: {
      migration: diagnostics.migration || [],
      conflicts: diagnostics.conflicts || [],
    },
  };
}

// ── Tamper detection ─────────────────────────────────────────────────────────

/**
 * Compare stored view hashes (from context.json) with the current on-disk
 * view contents. Returns one warning per manually edited view. Missing views
 * are regenerated silently; only content mismatches warn. The warnings never
 * trigger an import — generated views are overwritten from the map on save.
 */
export function viewTamperWarnings(storedViews, currentContents) {
  const warnings = [];
  for (const [name, hash] of Object.entries(storedViews || {})) {
    const content = currentContents ? currentContents[name] : undefined;
    if (content == null) continue;
    if (sha256Hex(content) !== hash) {
      warnings.push(
        `Warning: ${name} was manually edited, but it is generated from context-map.md. ` +
        "Edit context-map.md instead — manual view changes are never imported and are overwritten on save."
      );
    }
  }
  return warnings;
}

// ── v3 generated view and metadata ───────────────────────────────────────────
// In v3 the only generated view is `views/HANDOFF.md`, rendered from the
// canonical state (directory + content files). `context.json` carries protocol
// metadata, Git state, monotonic ID counters, SHA-256 hashes of the Map, every
// content file, and the view, plus diagnostics. No semantic bodies live in
// metadata.

import {
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
  V3_SECTION_LABELS,
  emptyContextMapV3,
  renderContextMapV3,
} from "./context-map.mjs";
import { CONTENT_DIR, CONTENT_FILES } from "./content-files.mjs";
import {
  emptyV3Content,
  recoverIdCounters,
  renderContentFile,
} from "./handoff-state.mjs";

/** First line of the generated v3 view; points editors at the canonical files. */
export const V3_GENERATED_MARKER =
  "<!-- generated-from: context-map.md + content/*.md; do not edit -->";

function v3EntryFor(content, key, id) {
  for (const entry of (content && content[key]) || []) {
    if (entry.id === id) return entry;
  }
  return null;
}

function renderV3HandoffMd(state, metadata) {
  const map = (state && state.map) || emptyContextMapV3();
  const content = (state && state.content) || emptyV3Content();
  const git = metadata.git || {};
  const lang = metadata.lang && V3_SECTION_LABELS.goals[metadata.lang] ? metadata.lang : "en";

  const lines = [
    V3_GENERATED_MARKER,
    "",
    "<!-- Edit context-map.md (labels, structure, task state) and the content/*.md files",
    "     (summaries and bodies) instead — this file is regenerated on every save. -->",
    "",
    "# Project Handoff",
    "",
    `**Saved**: ${metadata.timestamp || "unknown"}`,
    `**Agent**: ${metadata.agent || "unknown"}`,
    `**Project**: ${metadata.project || "unknown"}`,
    `**Branch**: ${git.branch || "unknown"}`,
    `**Commit**: ${git.latest_commit || "unknown"} - ${git.commit_message || ""}`,
  ];

  for (const key of V3_SECTION_KEYS) {
    lines.push("", `## ${V3_SECTION_LABELS[key][lang]}`, "");
    const nodes = map.sections[key] || [];
    if (nodes.length === 0) {
      lines.push(key === "goals" ? "No explicit goal set." : "None.");
      continue;
    }
    for (const node of nodes) {
      const entry = node.id != null ? v3EntryFor(content, key, node.id) : null;
      const indent = "  ".repeat(Math.max(0, Number(node.depth) || 0));
      let heading = "- ";
      if (key === "tasks") heading += `[${node.checked ? "x" : " "}] `;
      if (node.id != null) heading += `\`${node.id}\` `;
      if (key === "tasks" && node.priority) heading += `**${node.priority}** `;
      if (key === "risks" && node.severity) heading += `**${node.severity}** `;
      heading += node.label;
      lines.push(`${indent}${heading}`);
      if (entry && entry.summary) lines.push(`${indent}  ${entry.summary}`);
      if (entry && entry.body) {
        for (const block of entry.body.split("\n")) lines.push(`${indent}  ${block}`);
      }
    }
  }

  lines.push("", "---", "", `*Generated by Handoff Protocol v${V3_PROTOCOL_VERSION}*`);
  return lines.join("\n") + "\n";
}

/**
 * Render every canonical and generated file of a v3 handoff directory.
 * Returns an object keyed by handoff-relative path:
 * `context-map.md`, `content/<file>` × 8, and `views/HANDOFF.md`.
 * Identical state + metadata always produce identical contents.
 */
export function renderV3Files(state, metadata = {}) {
  const files = {};
  files["context-map.md"] = renderContextMapV3(state.map, { lang: metadata.lang });
  for (const key of V3_SECTION_KEYS) {
    files[`${CONTENT_DIR}/${CONTENT_FILES[key]}`] = renderContentFile(key, state.content[key]);
  }
  files["views/HANDOFF.md"] = renderV3HandoffMd(state, metadata);
  return files;
}

/**
 * Generate the v3 views from the canonical state. Returns
 * `{ "views/HANDOFF.md": string }`; the view includes every node label,
 * summary, and body in stable section/node order.
 */
export function generateV3Views(state, metadata = {}) {
  return { "views/HANDOFF.md": renderV3HandoffMd(state, metadata) };
}

/**
 * Build the v3 context.json: protocol version, timestamp, Agent, project,
 * Git state, monotonic ID counters, SHA-256 hashes of the Map, every content
 * file, and the generated view, plus diagnostics. No semantic fields.
 */
export function buildV3ContextJson({ state, project, git, environment = {}, diagnostics = {}, files } = {}) {
  const metadata = { ...environment, project, git };
  const rendered = files || renderV3Files(state, metadata);
  const hashes = {};
  for (const [name, content] of Object.entries(rendered)) {
    hashes[name] = sha256Hex(content);
  }
  const { counters } = recoverIdCounters(state, null);
  return {
    protocolVersion: V3_PROTOCOL_VERSION,
    timestamp: environment.timestamp || "",
    agent: environment.agent || "unknown",
    project: project || "unknown",
    lang: environment.lang,
    git: git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
    idCounters: counters,
    hashes,
    diagnostics: {
      migration: diagnostics.migration || [],
      conflicts: diagnostics.conflicts || [],
      integrity: diagnostics.integrity || (state && state.diagnostics) || [],
    },
  };
}

/**
 * Build the complete initial v3 layout for `/handoff init`: an empty Context
 * Map (empty Current Goal included), eight empty content files, the generated
 * view, and v3 metadata. No legacy root-level HANDOFF.md/tasks.md/decisions.md.
 */
export function buildInitialV3Files({ project, timestamp, agent, lang } = {}) {
  const state = {
    version: V3_PROTOCOL_VERSION,
    map: emptyContextMapV3(),
    content: emptyV3Content(),
    diagnostics: [],
  };
  const metadata = { timestamp: timestamp || "", agent: agent || "unknown", project: project || "unknown", lang };
  const files = renderV3Files(state, metadata);
  const contextJson = buildV3ContextJson({
    state,
    project,
    environment: { timestamp: metadata.timestamp, agent: metadata.agent, lang },
    files,
  });
  files["context.json"] = JSON.stringify(contextJson, null, 2) + "\n";
  return files;
}

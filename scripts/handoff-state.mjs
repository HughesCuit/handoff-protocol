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
  emptyContextMapV3,
  nodeFingerprint,
  normalizeNodeText,
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

// ── Stable ID allocation ─────────────────────────────────────────────────────

/** Empty content bucket for all eight sections. */
export function emptyV3Content() {
  const content = {};
  for (const key of V3_SECTION_KEYS) content[key] = [];
  return content;
}

/**
 * Reconstruct the per-prefix high-water counters. Valid `metadata.idCounters`
 * entries win; live Map/body IDs raise stale values. Returns
 * `{ counters, recovered }` where `recovered` flags missing or damaged
 * metadata (ID_COUNTER_RECOVERED territory). Counters are monotonic: they
 * never decrement and holes are never filled.
 */
export function recoverIdCounters(state, metadata) {
  const counters = {};
  for (const prefix of Object.values(ID_PREFIXES)) counters[prefix] = 0;

  let recovered = false;
  const stored = metadata && metadata.idCounters;
  if (stored == null) {
    recovered = true;
  } else if (typeof stored === "object" && !Array.isArray(stored)) {
    for (const [prefix, value] of Object.entries(stored)) {
      if (!(prefix in counters)) continue;
      if (Number.isInteger(value) && value >= 0) counters[prefix] = value;
      else recovered = true;
    }
  } else {
    recovered = true;
  }

  if (state) {
    const ids = [];
    if (state.map) {
      for (const key of V3_SECTION_KEYS) {
        for (const node of (state.map.sections && state.map.sections[key]) || []) {
          if (node.id != null) ids.push(node.id);
        }
      }
    }
    if (state.content) {
      for (const key of V3_SECTION_KEYS) {
        for (const entry of state.content[key] || []) ids.push(entry.id);
      }
    }
    for (const id of ids) {
      const match = typeof id === "string" && id.match(NODE_ID_RE);
      if (match) counters[match[1]] = Math.max(counters[match[1]], parseInt(match[2], 10));
    }
  }

  return { counters, recovered };
}

/**
 * Allocate the next ID for a section, advancing the counter in place.
 * IDs are never reused, even after their node is deleted.
 */
export function allocateNodeId(sectionKey, counters) {
  const prefix = ID_PREFIXES[sectionKey];
  if (!prefix) throw new Error(`unknown section '${sectionKey}' — cannot allocate a node ID`);
  const next = (Number(counters[prefix]) || 0) + 1;
  counters[prefix] = next;
  return `${prefix}${next}`;
}

// ── Ownership-aware reconciliation ───────────────────────────────────────────

const V3_SINGLETON_SECTIONS = new Set(["goals", "status"]);

function normalizeUserIntent(userIntent) {
  if (!userIntent) return {};
  if (typeof userIntent === "string") {
    const note = userIntent.trim();
    return note ? { notes: note } : {};
  }
  const intent = {};
  for (const key of V3_SECTION_KEYS) {
    const value = userIntent[key] ?? (key === "goals" ? userIntent.goal : undefined);
    if (typeof value === "string" && value.trim()) intent[key] = value.trim();
  }
  return intent;
}

function normalizeLabel(label) {
  return normalizeNodeText(label);
}

/**
 * Reconcile an existing v3 state with fresh agent inference and explicit
 * user intent. Ownership domains are independent:
 *
 *   - Directory (ID, label, parent, order, task state, priority, severity):
 *     user edits always win; agent-owned nodes may be updated in place
 *     (keeping their ID) or replaced by fresh inference.
 *   - Content (summary, body): user-owned entries are never overwritten;
 *     agent-owned entries follow supported inference.
 *
 * Current Goal is special: only an explicit user goal or an existing valid
 * goal populates it — inference (including commit-derived text) is rejected
 * and reported. A deleted node is never recreated from its leftover body;
 * orphan bodies are retained and reported, not auto-deleted.
 *
 * Returns `{ map, content, counters, diagnostics }`.
 */
export function reconcileV3State({ existing, inferred, userIntent, metadata } = {}) {
  const priorMap = (existing && existing.map) || emptyContextMapV3();
  const priorContent = (existing && existing.content) || emptyV3Content();
  const intent = normalizeUserIntent(userIntent);
  const { counters, recovered } = recoverIdCounters(
    existing ? { map: priorMap, content: priorContent } : null,
    metadata
  );

  const diagnostics = [];
  if (recovered && (existing || metadata)) {
    diagnostics.push("ID_COUNTER_RECOVERED: metadata counters were reconstructed from durable state");
  }
  const reject = (msg) => diagnostics.push(`INFERENCE_REJECTED: ${msg}`);

  const priorEntryById = new Map();
  for (const key of V3_SECTION_KEYS) {
    for (const entry of priorContent[key] || []) priorEntryById.set(entry.id, entry);
  }

  const resultMap = emptyContextMapV3();
  const resultContent = emptyV3Content();
  const contentUpdates = new Map(); // node id -> inferred entry

  for (const key of V3_SECTION_KEYS) {
    const priorNodes = priorMap.sections[key] || [];
    const userNodes = priorNodes.filter((n) => n.origin !== "agent");
    const agentNodes = priorNodes.filter((n) => n.origin === "agent");
    const inferredNodes = ((inferred && inferred[key]) || []).filter((n) => n);
    const intentLabel = intent[key];

    let nodes;

    if (key === "goals") {
      // Only an explicit user goal or an existing valid goal populates this
      // section. Commit-derived or otherwise inferred goals are rejected.
      if (intentLabel) {
        const current = priorNodes[0];
        nodes = [
          current
            ? { ...current, label: intentLabel, origin: "user" }
            : { id: allocateNodeId("goals", counters), label: intentLabel, origin: "user", depth: 0 },
        ];
      } else {
        nodes = priorNodes.slice();
        for (const inf of inferredNodes) {
          reject(
            `goal '${String(inf.label || "").slice(0, 60)}' — Current Goal only comes from an explicit user goal`
          );
        }
      }
    } else if (V3_SINGLETON_SECTIONS.has(key) && userNodes.length > 0) {
      nodes = userNodes.slice();
      for (const inf of inferredNodes) {
        reject(`status '${String(inf.label || "").slice(0, 60)}' — a user-owned status suppresses inference`);
      }
    } else if (inferredNodes.length === 0) {
      nodes = priorNodes.slice();
    } else {
      nodes = userNodes.slice();
      const seen = new Set(userNodes.map((n) => normalizeLabel(n.label)));
      const agentByNorm = new Map(agentNodes.map((n) => [normalizeLabel(n.label), n]));
      const singletonAgent = key === "status" ? agentNodes[0] || null : null;
      let singletonAgentUsed = false;

      for (const inf of inferredNodes) {
        const label = String(inf.label ?? inf.text ?? "").trim();

        if (inf.id != null) {
          const target = priorNodes.find((n) => n.id === inf.id);
          if (!target) {
            reject(`'${inf.id}' does not name an existing node`);
            continue;
          }
          if (target.origin === "user") {
            reject(`'${inf.id}' is user-owned — inferred changes to it were rejected`);
            continue;
          }
          if (label) target.label = label;
          if (key === "tasks" && inf.checked !== undefined) target.checked = !!inf.checked;
          if (key === "tasks" && inf.priority) target.priority = inf.priority;
          if (key === "risks" && inf.severity) target.severity = inf.severity;
          if (!nodes.includes(target)) {
            nodes.push(target);
            seen.add(normalizeLabel(target.label));
          }
          contentUpdates.set(target.id, inf);
          continue;
        }

        if (!label) continue;
        const norm = normalizeLabel(label);

        if (seen.has(norm)) {
          const matched = nodes.find((n) => normalizeLabel(n.label) === norm);
          if (matched && matched.origin === "agent") {
            if (key === "tasks" && inf.checked !== undefined) matched.checked = !!inf.checked;
            if (key === "tasks" && inf.priority) matched.priority = inf.priority;
            if (key === "risks" && inf.severity) matched.severity = inf.severity;
            contentUpdates.set(matched.id, inf);
          } else if (
            matched &&
            (inf.summary !== undefined || inf.body !== undefined ||
              (key === "tasks" && inf.checked !== undefined && inf.checked !== !!matched.checked))
          ) {
            reject(`'${matched.id || label}' is user-owned — inferred changes to it were rejected`);
          }
          continue;
        }

        const agentMatch = agentByNorm.get(norm);
        if (agentMatch) {
          if (key === "tasks") {
            agentMatch.checked = !!inf.checked;
            if (inf.priority) agentMatch.priority = inf.priority;
          }
          if (key === "risks" && inf.severity) agentMatch.severity = inf.severity;
          nodes.push(agentMatch);
          seen.add(norm);
          contentUpdates.set(agentMatch.id, inf);
          continue;
        }

        if (singletonAgent && !singletonAgentUsed) {
          // Singleton section (status): update the agent node in place,
          // keeping its ID, rather than appending a second node.
          singletonAgentUsed = true;
          singletonAgent.label = label;
          nodes.push(singletonAgent);
          seen.add(norm);
          contentUpdates.set(singletonAgent.id, inf);
          continue;
        }

        const node = {
          id: allocateNodeId(key, counters),
          label,
          origin: "agent",
          depth: Math.max(0, Number(inf.depth) || 0),
        };
        if (key === "tasks") {
          node.checked = !!inf.checked;
          if (inf.priority) node.priority = inf.priority;
        }
        if (key === "risks" && inf.severity) node.severity = inf.severity;
        nodes.push(node);
        seen.add(norm);
        contentUpdates.set(node.id, inf);
      }
    }

    // Explicit user intent appends (or, for singletons, replaces) nodes.
    if (intentLabel && key !== "goals") {
      if (V3_SINGLETON_SECTIONS.has(key) && nodes.length > 0) {
        nodes = [{ ...nodes[0], label: intentLabel, origin: "user" }];
      } else if (!nodes.some((n) => normalizeLabel(n.label) === normalizeLabel(intentLabel))) {
        nodes.push({
          id: allocateNodeId(key, counters),
          label: intentLabel,
          origin: "user",
          depth: 0,
          ...(key === "tasks" ? { checked: false } : {}),
        });
      }
    }

    resultMap.sections[key] = nodes;
  }

  // Content reconciliation: entries follow their node into the node's current
  // section; user-owned entries pass through verbatim; orphan bodies are
  // retained in their original file and reported, never auto-deleted.
  const placedIds = new Set();
  for (const key of V3_SECTION_KEYS) {
    for (const node of resultMap.sections[key]) {
      if (node.id == null) continue;
      placedIds.add(node.id);
      const priorEntry = priorEntryById.get(node.id) || null;
      const update = contentUpdates.get(node.id);
      if (priorEntry && priorEntry.origin === "user") {
        resultContent[key].push(priorEntry);
      } else if (update && (update.summary !== undefined || update.body !== undefined)) {
        resultContent[key].push({
          id: node.id,
          summary: update.summary ?? (priorEntry ? priorEntry.summary : "") ?? "",
          body: update.body ?? (priorEntry ? priorEntry.body : "") ?? "",
          origin: "agent",
        });
      } else if (priorEntry) {
        resultContent[key].push(priorEntry);
      }
    }
  }
  for (const key of V3_SECTION_KEYS) {
    for (const entry of priorContent[key] || []) {
      if (!placedIds.has(entry.id)) resultContent[key].push(entry); // orphan, retained
    }
  }

  const state = { version: V3_PROTOCOL_VERSION, map: resultMap, content: resultContent };
  return {
    map: resultMap,
    content: resultContent,
    counters,
    diagnostics: [...diagnostics, ...validateHandoffState(state)],
  };
}

// ── Save-path inference ──────────────────────────────────────────────────────

/**
 * Derive inferred v3 sections from verified project evidence (git state, TODO
 * scan, machine status). Current Goal is NEVER inferred — only an explicit
 * user goal or an existing valid goal populates that section, so commit
 * messages (including release commits) can never become a goal.
 *
 * `evidence`: { status?, todos?: [{ task, priority?, status? }], nextSteps?,
 *   decisions?: [{ title?, decision }], risks?, blockers?, notes? }.
 * Returns `{ [sectionKey]: [{ label, summary, checked?, priority? }] }`.
 */
export function buildInferredV3Sections(evidence = {}) {
  const inferred = {};
  for (const key of V3_SECTION_KEYS) inferred[key] = [];

  const status = String(evidence.status || "").trim();
  if (status) inferred.status.push({ label: status, summary: status });

  for (const todo of evidence.todos || []) {
    if (!todo || !todo.task) continue;
    const label = String(todo.task).trim();
    if (!label) continue;
    inferred.tasks.push({
      label,
      summary: label,
      checked: todo.status === "completed",
      priority: typeof todo.priority === "string" && todo.priority ? todo.priority : "medium",
    });
  }
  for (const step of evidence.nextSteps || []) {
    const label = String(step || "").trim();
    if (label) inferred.tasks.push({ label, summary: label, checked: false });
  }

  for (const d of evidence.decisions || []) {
    const label = (d && d.title ? `${d.title}: ${d.decision}` : String((d && d.decision) || "")).trim();
    if (label) inferred.decisions.push({ label, summary: label });
  }

  for (const risk of [...(evidence.risks || []), ...(evidence.blockers || [])]) {
    const label = String(risk || "").trim();
    if (label) inferred.risks.push({ label, summary: label });
  }

  for (const line of String(evidence.notes || "").split("\n")) {
    const label = line.trim();
    if (label) inferred.notes.push({ label, summary: label });
  }

  return inferred;
}

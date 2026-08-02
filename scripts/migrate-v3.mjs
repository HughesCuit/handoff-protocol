// @ts-nocheck
/**
 * Handoff Protocol v3 — Automatic atomic v2-to-v3 migration (shared module).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno and Node.js
 * implementations (no `Deno.*`, no `node:*`): applyV3Migration performs all
 * filesystem work through an injected `io` adapter, so behavior stays
 * identical across runtimes and the atomicity guarantees are testable with an
 * in-memory filesystem.
 *
 * Model
 * -----
 * The first `/handoff save` that detects a pre-v3 layout migrates
 * automatically. The v2 Context Map is the primary semantic source; when it
 * is absent or invalid the legacy (1.x) sources chain through the v2
 * migration planner first, so precedence stays
 * `user/map > context.json > Markdown views > inference`. Every v2 node —
 * including nested children — becomes its own v3 directory node with a
 * stable, never-reused ID; the complete original node text becomes the body
 * entry's summary, and the label is derived deterministically (text through
 * the first clause delimiter, limited to 60 Unicode code points with an
 * ellipsis when truncated).
 *
 * Atomicity
 * ---------
 * `planV2ToV3Migration(inputs, options?)` is pure: no clock, no I/O, no
 * mutation of its inputs. `applyV3Migration(io, plan, options?)` validates
 * the plan and every output first, writes all outputs through temporary
 * siblings, re-validates them, backs up the originals (sensitive-data
 * filtered) under `.handoff/history/migrations/<UTC-timestamp>/`, then
 * renames everything into place — the config version upgrade renames last.
 * Any failure before the commit point rolls every replacement back; cleanup
 * after the commit point (dropping rollback siblings, retiring the old root
 * HANDOFF.md/tasks.md/decisions.md) is best-effort and can never trigger a
 * destructive rollback. Migration is idempotent: a v3 project is never
 * assigned a second set of IDs.
 */

import {
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
  contextMapHasContent,
  emptyContextMapV3,
  filterSensitive,
  parseContextMap,
  parseContextMapV3,
} from "./context-map.mjs";
import { CONTENT_DIR, CONTENT_FILES } from "./content-files.mjs";
import {
  allocateNodeId,
  emptyV3Content,
  parseContentFile,
  validateHandoffState,
} from "./handoff-state.mjs";
import {
  MIGRATION_ROLLBACK_SUFFIX,
  MIGRATION_TMP_SUFFIX,
  planMigration,
} from "./migrate.mjs";
import {
  GENERATED_MARKER,
  V3_GENERATED_MARKER,
  buildV3ContextJson,
  renderV3Files,
} from "./views.mjs";
import { validateProjectConfig } from "./config.mjs";

const CONFIG_OUTPUT_NAME = ".handoff.config.json";
/** Root files retired after a successful migration (kept in the backup). */
const RETIRED_ROOT_FILES = ["HANDOFF.md", "tasks.md", "decisions.md"];
/** Files backed up before any replacement happens. */
const BACKUP_SOURCES = ["context-map.md", "HANDOFF.md", "tasks.md", "decisions.md", "context.json"];

/** v2 section key → v3 section key. */
const V2_TO_V3_SECTION = {
  goal: "goals",
  status: "status",
  tasks: "tasks",
  decisions: "decisions",
  questions: "questions",
  risks: "risks",
  knowledge: "notes",
  excluded: "excluded",
};

// ── Layout detection ─────────────────────────────────────────────────────────

/**
 * Classify a handoff layout from the relative file names present:
 * "v3" (content/ or views/ exists), "v2" (a Context Map without content/),
 * "legacy" (only pre-map files), or "empty".
 */
export function detectLayout(files) {
  const names = files instanceof Set ? [...files] : [...(files || [])];
  if (names.some((n) => n.startsWith(`${CONTENT_DIR}/`) || n.startsWith("views/"))) return "v3";
  if (names.includes("context-map.md")) return "v2";
  if (names.some((n) => ["HANDOFF.md", "tasks.md", "decisions.md", "context.json"].includes(n))) return "legacy";
  return "empty";
}

// ── Label derivation ─────────────────────────────────────────────────────────

const CLAUSE_DELIMITER_RE = /[.!?。！？;；\n]/;
const LABEL_MAX_CODE_POINTS = 60;

/**
 * Derive a directory label from a full v2 node text: text through the first
 * sentence/clause delimiter (`.`, `!`, `?`, `。`, `！`, `？`, `;`, `；`, or a
 * line break), or all text when no delimiter exists, limited to 60 Unicode
 * code points with an ellipsis appended when truncated.
 */
export function deriveNodeLabel(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const at = clean.search(CLAUSE_DELIMITER_RE);
  let label = (at >= 0 ? clean.slice(0, at) : clean).trim();
  const chars = [...label];
  if (chars.length > LABEL_MAX_CODE_POINTS) {
    label = chars.slice(0, LABEL_MAX_CODE_POINTS).join("").trimEnd() + "…";
  }
  return label || [...clean].slice(0, LABEL_MAX_CODE_POINTS).join("");
}

const PRIORITY_PREFIX_RE = /^\*\*(high|medium|low)\*\*\s+/i;

function splitPriority(text) {
  const match = String(text || "").match(PRIORITY_PREFIX_RE);
  if (!match) return { text: String(text || "").trim(), priority: null };
  return { text: String(text).replace(PRIORITY_PREFIX_RE, "").trim(), priority: match[1].toLowerCase() };
}

// ── v2 map → v3 state ────────────────────────────────────────────────────────

/**
 * Convert a parsed v2 Context Map into a v3 `{ map, content, counters }`.
 * IDs allocate by semantic section and original document order; hierarchy,
 * task state, priority/severity, localized headings (via render lang), and
 * detected ownership are preserved. Each original child becomes its own
 * directory node and body.
 */
export function convertV2MapToV3State(v2map) {
  const map = emptyContextMapV3();
  const content = emptyV3Content();
  const counters = {};

  for (const [v2Key, v3Key] of Object.entries(V2_TO_V3_SECTION)) {
    for (const node of (v2map.sections && v2map.sections[v2Key]) || []) {
      const id = allocateNodeId(v3Key, counters);
      const { text, priority } = splitPriority(node.text);
      const v3node = {
        id,
        label: deriveNodeLabel(text),
        origin: node.origin === "agent" ? "agent" : "user",
        depth: Math.max(0, Number(node.depth) || 0),
      };
      if (v3Key === "tasks") {
        v3node.checked = !!node.checked;
        if (priority) v3node.priority = priority;
      }
      if (v3Key === "risks" && priority) v3node.severity = priority;
      map.sections[v3Key].push(v3node);
      content[v3Key].push({ id, summary: text, body: "", origin: v3node.origin });
    }
  }

  map.extras = (v2map.extras || []).map((e) => ({ heading: e.heading, body: [...e.body] }));
  return { map, content, counters };
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function majorVersion(version) {
  const m = String(version ?? "").trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

const LEGACY_SEMANTIC_FIELDS = [
  "current_goal", "status", "todos", "decisions", "risks", "notes",
  "next_steps", "blockers", "completed",
];

/**
 * True when the inputs carry legacy semantic sources alongside (or instead
 * of) the v2 Context Map: a context.json with semantic fields, or root
 * Markdown files that are not generated views. Clean v2 handoffs — a map,
 * semantics-free context.json, generated views — migrate directly from the
 * map; anything else chains through the v2 migration planner so precedence
 * and conflict preservation stay identical to v2.
 */
function hasLegacySemantics(inputs, json) {
  if (json && LEGACY_SEMANTIC_FIELDS.some((f) => json[f] != null)) return true;
  for (const key of ["handoffMd", "tasksMd", "decisionsMd"]) {
    const raw = inputs[key];
    if (raw != null && !String(raw).startsWith(GENERATED_MARKER)) return true;
  }
  return false;
}

/**
 * Plan the v2-to-v3 migration. Pure: no clock, no I/O, no input mutation.
 *
 * `inputs`: { config?, contextJson?, handoffMd?, tasksMd?, decisionsMd?,
 *             contextMapMd?, contentFiles? } (file CONTENTS, like the v2
 *             migration planner; `contentFiles` maps content-file names to
 *             contents and marks an existing v3 layout).
 *
 * Returns `{ needed, reason, map?, content?, counters?, valid?, diagnostics,
 * sourceFiles?, metadata?, config?, outputs?, removals? }` where `outputs`
 * maps handoff-relative paths (plus `.handoff.config.json`) to their target
 * bytes and `removals` lists the retired root files.
 */
export function planV2ToV3Migration(inputs = {}, options = {}) {
  const diagnostics = { migration: [], conflicts: [] };
  const notNeeded = (reason) => ({ needed: false, reason, diagnostics });

  // Already v3: a content/ layout or v3 metadata markers are never re-migrated.
  if (inputs.contentFiles && Object.keys(inputs.contentFiles).length > 0) {
    return notNeeded("already v3 (content/ layout present)");
  }
  const json = inputs.contextJson != null ? parseJsonObject(inputs.contextJson) : null;
  if (json && majorVersion(json.protocolVersion) >= 3) {
    return notNeeded(`already v3 (protocolVersion ${json.protocolVersion})`);
  }

  // Primary source: the v2 Context Map. Fall back to the chained legacy
  // migration (1.x sources, or a v2 handoff whose map is unusable).
  let v2map = null;
  if (inputs.contextMapMd != null && String(inputs.contextMapMd).trim()) {
    v2map = parseContextMap(inputs.contextMapMd);
    if (!contextMapHasContent(v2map)) {
      v2map = null;
      diagnostics.migration.push("context-map.md is empty or malformed; falling back to legacy sources");
    }
  }

  let metadata;
  let sourceFiles;
  const directFromMap = () => {
    metadata = {
      timestamp: (json && json.timestamp) || "",
      agent: (json && json.agent) || "unknown",
      project: (json && json.project) || "unknown",
      lang: json && json.lang,
      git: (json && json.git) || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
    };
    sourceFiles = ["context-map.md"];
    if (json) sourceFiles.push("context.json");
  };

  if (v2map && !hasLegacySemantics(inputs, json)) {
    directFromMap();
  } else {
    const chained = planMigration(inputs, options.userInstructions);
    if (chained.needed) {
      v2map = chained.map;
      metadata = chained.metadata;
      sourceFiles = chained.sourceFiles;
      diagnostics.migration.push(...chained.diagnostics.migration);
      diagnostics.conflicts.push(...chained.diagnostics.conflicts);
    } else if (v2map) {
      directFromMap();
    } else {
      return notNeeded(chained.reason || "nothing to migrate");
    }
  }

  // Convert to the canonical v3 state.
  const { map, content, counters } = convertV2MapToV3State(v2map);

  // Preservation check: every original semantic text must appear in the
  // proposed bodies.
  const missing = [];
  for (const [v2Key, v3Key] of Object.entries(V2_TO_V3_SECTION)) {
    const entries = content[v3Key];
    for (const node of (v2map.sections && v2map.sections[v2Key]) || []) {
      const { text } = splitPriority(node.text);
      if (!text) continue;
      const present = entries.some((e) => `${e.summary}\n${e.body}`.includes(text));
      if (!present) missing.push(text);
    }
  }
  const valid = missing.length === 0;
  if (!valid) {
    diagnostics.migration.push(`validation failed: ${missing.length} original node text(s) missing from the proposed state`);
  }

  diagnostics.migration.push(
    `migrated handoff to v${V3_PROTOCOL_VERSION} (sources: ${sourceFiles.join(", ") || "none"}; ` +
      `${map.sections.tasks.length} task(s), ${map.sections.decisions.length} decision(s), ${diagnostics.conflicts.length} conflict(s))`
  );

  const state = { version: V3_PROTOCOL_VERSION, map, content, diagnostics: [] };
  const files = renderV3Files(state, metadata);
  const outputs = {};
  for (const [name, contentText] of Object.entries(files)) {
    outputs[name] = filterSensitive(contentText);
  }
  const contextJson = buildV3ContextJson({
    state,
    project: metadata.project,
    git: metadata.git,
    environment: { timestamp: metadata.timestamp, agent: metadata.agent, lang: metadata.lang },
    diagnostics,
    files: outputs,
  });
  outputs["context.json"] = filterSensitive(JSON.stringify(contextJson, null, 2));

  // Config: version upgrade (renamed last by applyV3Migration).
  let upgradedConfig = null;
  const config = inputs.config != null ? parseJsonObject(inputs.config) : null;
  if (config) {
    upgradedConfig = { ...config, version: V3_PROTOCOL_VERSION };
    const validation = validateProjectConfig(upgradedConfig);
    if (validation.valid) {
      outputs[CONFIG_OUTPUT_NAME] = JSON.stringify(upgradedConfig, null, 2) + "\n";
    } else {
      upgradedConfig = null;
      diagnostics.migration.push("existing .handoff.config.json is not portable; leaving it unchanged");
    }
  }

  return {
    needed: true,
    reason: `pre-v3 handoff layout (v${V3_PROTOCOL_VERSION} introduces the content/ directory)`,
    map,
    content,
    counters,
    valid,
    diagnostics,
    sourceFiles,
    metadata,
    config: upgradedConfig,
    outputs,
    removals: [...RETIRED_ROOT_FILES],
  };
}

// ── Apply (atomic) ───────────────────────────────────────────────────────────

function sanitizeTimestamp(timestamp) {
  return String(timestamp).replace(/[:.]/g, "-");
}

/** Pure output validation — runs before any filesystem operation. */
function validateV3Outputs(plan) {
  const outputs = plan.outputs || {};

  const mapContent = outputs["context-map.md"];
  if (typeof mapContent !== "string") {
    throw new Error("v3 migration plan is invalid: missing context-map.md output");
  }
  const parsed = parseContextMapV3(mapContent);
  const nodeCount = (m) => V3_SECTION_KEYS.reduce((n, key) => n + (m.sections[key] || []).length, 0);
  if (!parsed || !plan.map || nodeCount(parsed) !== nodeCount(plan.map)) {
    throw new Error("v3 migration plan is invalid: context-map.md output fails the production parser");
  }

  for (const key of V3_SECTION_KEYS) {
    const name = `${CONTENT_DIR}/${CONTENT_FILES[key]}`;
    const raw = outputs[name];
    if (typeof raw !== "string") {
      throw new Error(`v3 migration plan is invalid: missing ${name} output`);
    }
    const expected = (plan.content && plan.content[key]) || [];
    const entries = parseContentFile(raw, key);
    if (entries.length !== expected.length) {
      throw new Error(`v3 migration plan is invalid: ${name} output lost entries`);
    }
  }

  const view = outputs["views/HANDOFF.md"];
  if (typeof view !== "string" || !view.startsWith(V3_GENERATED_MARKER)) {
    throw new Error("v3 migration plan is invalid: views/HANDOFF.md output is missing or unmarked");
  }

  let contextJson;
  try {
    contextJson = JSON.parse(outputs["context.json"]);
  } catch {
    throw new Error("v3 migration plan is invalid: context.json output is not valid JSON");
  }
  if (contextJson.protocolVersion !== V3_PROTOCOL_VERSION || !contextJson.hashes || !contextJson.idCounters) {
    throw new Error("v3 migration plan is invalid: context.json output is not a v3 context file");
  }

  if (outputs[CONFIG_OUTPUT_NAME] != null) {
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(outputs[CONFIG_OUTPUT_NAME]);
    } catch {
      throw new Error("v3 migration plan is invalid: .handoff.config.json output is not valid JSON");
    }
    const validation = validateProjectConfig(parsedConfig);
    if (!validation.valid) {
      throw new Error(`v3 migration plan is invalid: config output rejected: ${validation.errors.join("; ")}`);
    }
  }
}

/**
 * Apply a v2-to-v3 migration plan atomically.
 *
 * `paths`: { handoffDir, configPath? }. `io`: runtime-injected filesystem
 * adapter { readFile, writeFile, rename, mkdir, exists, remove }.
 * `options.timestamp` fixes the backup directory name (defaults to now).
 *
 * Sequence: validate plan → write temp siblings → re-validate temps → back up
 * originals (filtered) → rename data files into place (config LAST). Any
 * failure before every rename completes rolls replacements back byte-for-byte.
 * After the commit point, dropping rollback siblings and retiring the old
 * root views is best-effort and cannot trigger a rollback.
 *
 * Returns `{ migrated, backupDir?, written?, removed?, reason? }`.
 */
export async function applyV3Migration(io, plan, paths, options = {}) {
  if (!plan || !plan.needed) {
    return { migrated: false, reason: (plan && plan.reason) || "nothing to migrate" };
  }
  if (!paths.handoffDir) throw new Error("applyV3Migration requires paths.handoffDir");
  if (!io) throw new Error("applyV3Migration requires an io adapter");
  if (typeof io.remove !== "function") throw new Error("applyV3Migration requires io.remove for rename-phase rollback");
  if (!plan.valid) throw new Error("v3 migration plan failed validation; refusing to write");

  validateV3Outputs(plan);

  const handoffDir = paths.handoffDir;
  const configPath = paths.configPath;
  const outputs = plan.outputs;
  const backupDir = `${handoffDir}/history/migrations/${sanitizeTimestamp(options.timestamp || new Date().toISOString())}`;

  const temps = [];
  const replaced = [];
  try {
    // 1. Write every output through a temporary sibling file.
    for (const [name, content] of Object.entries(outputs)) {
      const finalPath = name === CONFIG_OUTPUT_NAME ? configPath : `${handoffDir}/${name}`;
      if (!finalPath) continue;
      const tempPath = `${finalPath}${MIGRATION_TMP_SUFFIX}`;
      await io.writeFile(tempPath, content);
      temps.push({ name, tempPath, finalPath });
    }

    // 2. Re-validate the temporary outputs as written on disk.
    for (const temp of temps) {
      const written = await io.readFile(temp.tempPath);
      validateV3Outputs({ map: plan.map, content: plan.content, outputs: { ...outputs, [temp.name]: written } });
    }

    // 3. Back up the originals (sensitive-data filtered) before replacing.
    await io.mkdir(backupDir);
    for (const name of BACKUP_SOURCES) {
      const original = `${handoffDir}/${name}`;
      if (await io.exists(original)) {
        await io.writeFile(`${backupDir}/${name}`, filterSensitive(await io.readFile(original)));
      }
    }
    if (configPath && (await io.exists(configPath))) {
      await io.writeFile(`${backupDir}/${CONFIG_OUTPUT_NAME}`, filterSensitive(await io.readFile(configPath)));
    }

    // 4. Rename data files into place; the version upgrade renames last.
    const ordered = [
      ...temps.filter((t) => t.name !== CONFIG_OUTPUT_NAME),
      ...temps.filter((t) => t.name === CONFIG_OUTPUT_NAME),
    ];
    for (const temp of ordered) {
      const entry = { finalPath: temp.finalPath, rollbackPath: null };
      if (await io.exists(temp.finalPath)) {
        entry.rollbackPath = `${temp.finalPath}${MIGRATION_ROLLBACK_SUFFIX}`;
        await io.rename(temp.finalPath, entry.rollbackPath);
      }
      replaced.push(entry);
      await io.rename(temp.tempPath, temp.finalPath);
    }
  } catch (err) {
    for (const entry of replaced.reverse()) {
      try {
        if (await io.exists(entry.finalPath)) await io.remove(entry.finalPath);
        if (entry.rollbackPath) await io.rename(entry.rollbackPath, entry.finalPath);
      } catch {
        // Best effort: keep restoring the remaining files.
      }
    }
    for (const temp of temps) {
      try {
        await io.remove(temp.tempPath);
      } catch {
        // Already renamed or never written: nothing to clean.
      }
    }
    throw err;
  }

  // COMMITTED. Best-effort cleanup: rollback siblings first, then retire the
  // old root views. Failures here never roll back the committed state.
  for (const entry of replaced) {
    if (entry.rollbackPath) {
      try {
        await io.remove(entry.rollbackPath);
      } catch {
        // Leftover rollback siblings are harmless.
      }
    }
  }
  const removed = [];
  for (const name of plan.removals || RETIRED_ROOT_FILES) {
    const path = `${handoffDir}/${name}`;
    try {
      if (await io.exists(path)) {
        await io.remove(path);
        removed.push(name);
      }
    } catch {
      // A lingering retired file is harmless; the backup holds its bytes.
    }
  }

  return { migrated: true, backupDir, written: Object.keys(outputs), removed };
}

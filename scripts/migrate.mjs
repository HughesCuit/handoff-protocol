// @ts-nocheck
/**
 * Handoff Protocol v2 — Atomic legacy migration (shared module).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/save.ts, scripts/load.ts) and the Node.js implementation
 * (scripts/node/save.mjs, scripts/node/load.mjs). It intentionally uses no
 * runtime-specific APIs (no `Deno.*`, no `node:*`): applyMigration performs
 * all filesystem work through an injected `io` adapter, so behavior stays
 * identical across runtimes and the atomicity guarantees are testable with an
 * in-memory filesystem.
 *
 * Migration model
 * ---------------
 * Legacy (1.x / v1.5) handoffs migrate into the canonical v2 model:
 * `.handoff/context-map.md` becomes the semantic source, the legacy files are
 * regenerated as deterministic views, `context.json` keeps only metadata plus
 * view hashes and diagnostics, and `.handoff.config.json` is upgraded to the
 * current protocol version.
 *
 * Precedence (highest first):
 *   1. Explicit current user instructions and direct Context Map edits.
 *   2. Structured legacy `context.json`.
 *   3. Human-readable legacy files (tasks.md, decisions.md, HANDOFF.md).
 *   4. Repository or Agent inference (never used by migration itself).
 *
 * Singleton fields (goal, status) have exactly one winner; conflicting
 * lower-priority values are never dropped — they stay visible as child nodes
 * below a "Migration conflict" node in Open Questions, each labeled with its
 * source file, and are mirrored into diagnostics.conflicts. List sections
 * (tasks, decisions, risks, questions, knowledge, exclusions) merge across
 * sources in precedence order with semantic deduplication, so task state,
 * decision rationale, risks, questions, and exclusions are all preserved.
 *
 * Atomicity
 * ---------
 * `planMigration(inputs, userInstructions?)` is pure: no clock, no I/O, no
 * mutation of its inputs. `applyMigration(plan, paths, io, options?)`
 * validates the plan and every output first, writes all outputs through
 * temporary sibling files, validates the temporary files, backs up the
 * originals (sensitive-data filtered) under
 * `.handoff/history/migrations/<UTC-timestamp>/`, and only then renames each
 * temp file into place — the configuration (the version upgrade) renames
 * last, after the final data rename. Any failure before the rename phase
 * leaves the original files and configuration untouched; a failure DURING
 * the rename phase rolls every already-replaced file back from its rollback
 * sibling, so the originals are again byte-identical and no mixed
 * legacy/v2 state can survive.
 */

import {
  CONTEXT_MAP_FILE,
  HANDOFF_FILES,
  PROTOCOL_VERSION,
  SECTION_KEYS,
  contextMapHasContent,
  emptyContextMap,
  filterSensitive,
  normalizeNodeText,
  parseContextMap,
  renderContextMap,
} from "./context-map.mjs";
import {
  GENERATED_MARKER,
  buildContextJson,
  generateViews,
  sha256Hex,
} from "./views.mjs";
import { validateProjectConfig } from "./config.mjs";

/** Parent node under Open Questions holding superseded lower-priority values. */
export const MIGRATION_CONFLICT_LABEL = "Migration conflict";
/** Suffix for the temporary sibling files outputs are written through. */
export const MIGRATION_TMP_SUFFIX = ".migration-tmp";
/** Suffix for the rollback siblings originals are moved to during the rename phase. */
export const MIGRATION_ROLLBACK_SUFFIX = ".migration-rollback";

const CONFIG_OUTPUT_NAME = ".handoff.config.json";
/** Canonical reporting order for the files a migration consumed. */
const SOURCE_ORDER = [CONTEXT_MAP_FILE, "context.json", "HANDOFF.md", "tasks.md", "decisions.md"];

// ── Version classification ───────────────────────────────────────────────────

function majorVersion(version) {
  const m = String(version ?? "").trim().match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Decide whether a handoff predates the canonical v2 model. The version
 * marker prefers context.json, then the project config; a map with no version
 * information at all is already canonical. A missing/unusable map always
 * means migration (the map is the only writable semantic source in v2).
 */
export function isMigrationNeeded({ mapPresent = false, contextVersion, configVersion } = {}) {
  const marker = contextVersion || configVersion || (mapPresent ? PROTOCOL_VERSION : null);
  if (!marker) return false; // no handoff data at all
  return !(mapPresent && majorVersion(marker) >= 2);
}

// ── Legacy source parsing ────────────────────────────────────────────────────

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Prefix a task with its priority unless it already carries a marker. */
function taskText(priority, task) {
  const text = String(task || "").trim();
  if (/^\*\*(high|medium|low)\*\*\s/i.test(text)) return text;
  return `**${typeof priority === "string" && priority ? priority : "medium"}** ${text}`;
}

/** Encode a legacy decision as one map node, keeping context and rationale. */
function decisionText({ title, context, decision, rationale } = {}) {
  let text = title ? `${title}: ${decision || ""}` : String(decision || "");
  text = text.trim();
  if (!text) return "";
  const extras = [];
  if (context) extras.push(`context: ${context}`);
  if (rationale) extras.push(`rationale: ${rationale}`);
  if (extras.length) text += ` (${extras.join("; ")})`;
  return text;
}

/** Semantic content harvested from a structured legacy context.json. */
function semanticsFromContextJson(json) {
  const s = { goal: "", status: "", tasks: [], decisions: [], risks: [], knowledge: [] };
  if (!json) return s;
  s.goal = String(json.current_goal || "").trim();
  s.status = String(json.status || "").trim();
  for (const todo of json.todos || []) {
    if (!todo || !todo.task) continue;
    s.tasks.push({ text: taskText(todo.priority, todo.task), checked: todo.status === "completed" });
  }
  for (const step of json.next_steps || []) {
    if (step) s.tasks.push({ text: String(step), checked: false });
  }
  for (const d of json.decisions || []) {
    const text = decisionText(d || {});
    if (text) s.decisions.push(text);
  }
  for (const risk of [...(json.risks || []), ...(json.blockers || [])]) {
    if (risk) s.risks.push(String(risk));
  }
  for (const line of String(json.notes || "").split("\n")) {
    const text = line.trim();
    if (text) s.knowledge.push(text);
  }
  return s;
}

/**
 * Parse a legacy HANDOFF.md. Goal/status sections hold plain prose lines;
 * list sections hold bullets or numbered items. Placeholder prose such as
 * "No risks identified." is not a bullet and is never captured.
 */
function parseLegacyHandoffMd(content) {
  const result = {
    goal: "",
    status: "",
    tasks: [],
    blockers: [],
    risks: [],
    nextSteps: [],
    completed: [],
    timestamp: "",
    agent: "",
    project: "",
    branch: "",
    commit: "",
    commitMessage: "",
  };

  for (const line of String(content).split("\n").slice(0, 10)) {
    const field = (label) => line.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*(.+)$`))?.[1]?.trim();
    const saved = field("Saved");
    if (saved) result.timestamp = saved;
    const agent = field("Agent");
    if (agent) result.agent = agent;
    const project = field("Project");
    if (project) result.project = project;
    const branch = field("Branch");
    if (branch) result.branch = branch;
    const commit = field("Commit");
    if (commit) {
      const cm = commit.match(/^(\S+)\s*-?\s*(.*)$/);
      result.commit = cm ? cm[1] : commit;
      result.commitMessage = cm ? cm[2] : "";
    }
  }

  let section = "";
  for (const rawLine of String(content).split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^-{3,}$/.test(trimmed) || trimmed.startsWith("*Generated by")) continue;
    const heading = trimmed.match(/^##\s+(.+)/);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }

    if (section === "current goal" || section === "current status") {
      const text = trimmed.replace(/^[-*]\s+/, "");
      if (section === "current goal" && !result.goal) result.goal = text;
      if (section === "current status" && !result.status) result.status = text;
      continue;
    }

    const item = trimmed.match(/^(?:[-*]|\d+[.)])\s+(.+?)$/);
    if (!item) continue;
    const text = item[1];
    switch (section) {
      case "completed work":
        result.completed.push(text);
        break;
      case "outstanding issues":
        result.blockers.push(text);
        break;
      case "todo": {
        const cb = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (cb) result.tasks.push({ text: cb[2].trim(), checked: cb[1].toLowerCase() === "x" });
        else result.tasks.push({ text, checked: false });
        break;
      }
      case "recommended next steps":
        result.nextSteps.push(text.replace(/^\d+\.\s*/, ""));
        break;
      case "risks / notes":
      case "risks":
        result.risks.push(text);
        break;
    }
  }
  return result;
}

/** Parse a legacy tasks.md (priority sections with checkbox bullets). */
function parseLegacyTasksMd(content) {
  const tasks = [];
  let priority = "medium";
  for (const rawLine of String(content).split("\n")) {
    const heading = rawLine.trim().match(/^##\s+(.+)/);
    if (heading) {
      const label = heading[1].trim().toLowerCase();
      if (label.includes("high")) priority = "high";
      else if (label.includes("low")) priority = "low";
      else if (label.includes("medium")) priority = "medium";
      continue;
    }
    const item = rawLine.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    if (!item || /^none$/i.test(item[2])) continue;
    tasks.push({ text: taskText(priority, item[2]), checked: item[1]?.toLowerCase() === "x" });
  }
  return tasks;
}

/** Parse a legacy decisions.md (## Title with Context/Decision/Rationale bullets). */
function parseLegacyDecisionsMd(content) {
  const decisions = [];
  let current = null;
  for (const rawLine of String(content).split("\n")) {
    const heading = rawLine.trim().match(/^##\s+(.+)/);
    if (heading) {
      if (current) decisions.push(current);
      const title = heading[1].trim();
      current = /^architecture decisions$/i.test(title)
        ? null
        : { title, context: "", decision: "", rationale: "" };
      continue;
    }
    if (!current) continue;
    const field = rawLine.match(/^\s*[-*]\s+\*\*(Context|Decision|Rationale)\*\*:\s*(.+?)\s*$/i);
    if (field) current[field[1].toLowerCase()] = field[2];
  }
  if (current) decisions.push(current);
  return decisions.map(decisionText).filter(Boolean);
}

/** Normalize the optional userInstructions argument (highest precedence). */
function parseUserInstructions(userInstructions) {
  const result = { goal: "", status: "", knowledge: [] };
  if (!userInstructions) return result;
  const pushNotes = (value) => {
    for (const note of Array.isArray(value) ? value : [value]) {
      const text = String(note ?? "").trim();
      if (text) result.knowledge.push(text);
    }
  };
  if (typeof userInstructions === "string" || Array.isArray(userInstructions)) {
    pushNotes(userInstructions);
    return result;
  }
  if (typeof userInstructions === "object") {
    if (typeof userInstructions.goal === "string") result.goal = userInstructions.goal.trim();
    if (typeof userInstructions.status === "string") result.status = userInstructions.status.trim();
    pushNotes(userInstructions.knowledge ?? userInstructions.notes ?? []);
  }
  return result;
}

// ── Merge helpers ────────────────────────────────────────────────────────────

/**
 * Record one conflict per lower-priority candidate whose value differs
 * (semantically) from the winner. Duplicated (value, source) pairs collapse.
 */
function collectConflicts(field, winnerValue, winnerSource, candidates, conflicts) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (normalizeNodeText(candidate.value) === normalizeNodeText(winnerValue)) continue;
    const key = `${normalizeNodeText(candidate.value)}${candidate.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ field, value: candidate.value, source: candidate.source, keptSource: winnerSource });
  }
}

/**
 * Resolve a singleton section (goal/status). User instructions beat direct
 * map edits, which beat legacy candidates (already in precedence order).
 */
function resolveSingleton(field, mapNodes, instructionValue, legacyCandidates, diagnostics, conflicts) {
  if (instructionValue) {
    diagnostics.migration.push(`user instruction applied to ${field}`);
    collectConflicts(field, instructionValue, "user instructions", legacyCandidates, conflicts);
    return [{ text: instructionValue, origin: "user", depth: 0 }];
  }
  if (mapNodes.length > 0) {
    collectConflicts(field, mapNodes[0].text, CONTEXT_MAP_FILE, legacyCandidates, conflicts);
    return mapNodes;
  }
  if (legacyCandidates.length > 0) {
    const [winner, ...losers] = legacyCandidates;
    collectConflicts(field, winner.value, winner.source, losers, conflicts);
    return [{ text: winner.value, origin: "user", depth: 0 }];
  }
  return [];
}

/** Append legacy list entries after the base (map) nodes, deduplicated. */
function mergeNodes(baseNodes, legacyLists) {
  const out = [...baseNodes];
  const seen = new Set(baseNodes.map((n) => normalizeNodeText(n.text)));
  for (const list of legacyLists) {
    for (const item of list) {
      const norm = normalizeNodeText(item.text);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const node = { text: item.text, origin: "user", depth: Math.max(0, Number(item.depth) || 0) };
      if (item.checked !== undefined) node.checked = !!item.checked;
      out.push(node);
    }
  }
  return out;
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

function emptyPlan(reason, diagnostics) {
  return {
    needed: false,
    reason,
    map: null,
    valid: false,
    diagnostics,
    sourceFiles: [],
    metadata: null,
    config: null,
    outputs: {},
  };
}

/**
 * Plan a legacy-to-v2 migration in memory. Pure: no I/O, no clock, no input
 * mutation — identical inputs always produce an identical plan.
 *
 * `inputs` carries raw file contents (undefined when a file is absent):
 *   { config, contextJson, handoffMd, tasksMd, decisionsMd, contextMapMd }
 * `userInstructions` (optional, highest precedence): a note string/array, or
 *   { goal?, status?, knowledge?|notes? } to override singletons / add notes.
 *
 * Returns `{ needed, reason, map, valid, diagnostics, sourceFiles, metadata,
 * config, outputs }`. When `needed` is false nothing else is populated.
 * `valid` reports that the proposed map survives a render/parse round-trip
 * through the production parser. `outputs` maps file names to their final
 * (sensitive-data-filtered) contents, including `.handoff.config.json` when a
 * valid config exists to upgrade.
 */
export function planMigration(inputs = {}, userInstructions) {
  const diagnostics = { migration: [], conflicts: [] };

  // Config alone is not handoff data: a fresh project that only ran
  // `/handoff init` has nothing to migrate.
  const hasAnyInput = ["contextJson", "handoffMd", "tasksMd", "decisionsMd", "contextMapMd"]
    .some((key) => inputs[key] != null);
  if (!hasAnyInput) return emptyPlan("no handoff data found", diagnostics);

  // Config (upgraded last by applyMigration; never blocks migration).
  let config = null;
  if (inputs.config != null) {
    config = parseJsonObject(inputs.config);
    if (!config) diagnostics.migration.push(".handoff.config.json is malformed; leaving it unchanged");
  }

  // Context Map: direct user edits — the highest-precedence file source.
  let mapParsed = null;
  if (inputs.contextMapMd != null && String(inputs.contextMapMd).trim()) {
    mapParsed = parseContextMap(inputs.contextMapMd);
    if (!contextMapHasContent(mapParsed)) {
      mapParsed = null;
      diagnostics.migration.push("context-map.md is empty or malformed; treating it as absent");
    }
  }
  const mapUsable = mapParsed !== null;

  // Structured legacy context.json outranks the human-readable files.
  let json = null;
  if (inputs.contextJson != null) {
    json = parseJsonObject(inputs.contextJson);
    if (!json) {
      diagnostics.migration.push("context.json is malformed or unreadable; falling back to human-readable legacy files");
    }
  }

  const marker = (json && json.version) || (config && config.version) || (mapUsable ? PROTOCOL_VERSION : null);
  if (!isMigrationNeeded({ mapPresent: mapUsable, contextVersion: json && json.version, configVersion: config && config.version })) {
    return emptyPlan(`already migrated (v${marker})`, diagnostics);
  }

  // Parse the remaining legacy sources.
  const instructions = parseUserInstructions(userInstructions);
  const jsonSemantics = semanticsFromContextJson(json);
  const handoff = inputs.handoffMd != null ? parseLegacyHandoffMd(inputs.handoffMd) : null;
  const tasksMd = inputs.tasksMd != null ? parseLegacyTasksMd(inputs.tasksMd) : [];
  const decisionsMd = inputs.decisionsMd != null ? parseLegacyDecisionsMd(inputs.decisionsMd) : [];

  // Consulted sources, in canonical order (malformed files are not sources).
  const present = new Set();
  if (mapUsable) present.add(CONTEXT_MAP_FILE);
  if (json) present.add("context.json");
  if (handoff) present.add("HANDOFF.md");
  if (inputs.tasksMd != null) present.add("tasks.md");
  if (inputs.decisionsMd != null) present.add("decisions.md");
  const sourceFiles = SOURCE_ORDER.filter((name) => present.has(name));

  // Build the migrated map: existing map nodes stay verbatim (user-owned).
  const map = emptyContextMap();
  if (mapParsed) {
    for (const key of SECTION_KEYS) {
      map.sections[key] = mapParsed.sections[key].map((n) => ({ ...n }));
    }
    map.extras = (mapParsed.extras || []).map((e) => ({ heading: e.heading, body: [...e.body] }));
  }

  // Singletons: goal and status.
  for (const field of ["goal", "status"]) {
    const legacyCandidates = [];
    if (jsonSemantics[field]) legacyCandidates.push({ value: jsonSemantics[field], source: "context.json" });
    if (handoff && handoff[field]) legacyCandidates.push({ value: handoff[field], source: "HANDOFF.md" });
    const instructionValue = field === "goal" ? instructions.goal : instructions.status;
    map.sections[field] = resolveSingleton(
      field,
      map.sections[field],
      instructionValue,
      legacyCandidates,
      diagnostics,
      diagnostics.conflicts
    );
  }

  // Lists: map nodes first, then context.json, then human-readable files.
  const handoffTasks = handoff ? handoff.tasks : [];
  const handoffNextSteps = handoff ? handoff.nextSteps.map((s) => ({ text: s, checked: false })) : [];
  map.sections.tasks = mergeNodes(map.sections.tasks, [jsonSemantics.tasks, tasksMd, handoffTasks, handoffNextSteps]);
  map.sections.decisions = mergeNodes(map.sections.decisions, [
    jsonSemantics.decisions.map((text) => ({ text })),
    decisionsMd.map((text) => ({ text })),
  ]);
  const handoffRisks = handoff ? [...handoff.risks, ...handoff.blockers].map((text) => ({ text })) : [];
  map.sections.risks = mergeNodes(map.sections.risks, [jsonSemantics.risks.map((text) => ({ text })), handoffRisks]);
  map.sections.knowledge = mergeNodes(map.sections.knowledge, [
    instructions.knowledge.map((text) => ({ text })),
    jsonSemantics.knowledge.map((text) => ({ text })),
  ]);

  // Superseded singleton values stay visible below a Migration conflict node.
  if (diagnostics.conflicts.length > 0) {
    map.sections.questions.push({ text: MIGRATION_CONFLICT_LABEL, origin: "user", depth: 0 });
    for (const conflict of diagnostics.conflicts) {
      map.sections.questions.push({
        text: `${conflict.field}: ${conflict.value} (source: ${conflict.source})`,
        origin: "user",
        depth: 1,
      });
    }
  }

  // Machine metadata for the generated views and context.json.
  const metadata = {
    timestamp: (json && json.timestamp) || (handoff && handoff.timestamp) || "",
    agent: (json && json.agent) || (handoff && handoff.agent) || "unknown",
    project: (json && json.project) || (handoff && handoff.project) || "unknown",
    lang: json && json.lang,
    verbosity: json && json.verbosity,
    git: (json && json.git) || {
      branch: (handoff && handoff.branch) || "unknown",
      latest_commit: (handoff && handoff.commit) || "",
      commit_message: (handoff && handoff.commitMessage) || "",
      is_dirty: false,
    },
    completed: (json && json.completed) || (handoff && handoff.completed) || [],
    modifiedFiles: (json && json.modified_files) || [],
    blockers: (json && json.blockers) || (handoff && handoff.blockers) || [],
    nextSteps: (json && json.next_steps) || (handoff && handoff.nextSteps) || [],
  };

  // Diagnostics summary.
  const taskCount = map.sections.tasks.length;
  const decisionCount = map.sections.decisions.length;
  diagnostics.migration.push(
    `migrated legacy handoff to v${PROTOCOL_VERSION} (sources: ${sourceFiles.join(", ") || "none"}; ` +
      `${taskCount} task(s), ${decisionCount} decision(s), ${diagnostics.conflicts.length} conflict(s))`
  );

  // Outputs (filtered before persistence). The map is validated with the
  // production parser: a render/parse round-trip must preserve every node.
  const outputs = {};
  outputs[CONTEXT_MAP_FILE] = filterSensitive(renderContextMap(map));
  const reparsed = parseContextMap(outputs[CONTEXT_MAP_FILE]);
  const valid =
    !!reparsed &&
    SECTION_KEYS.every((key) => (reparsed.sections[key] || []).length === map.sections[key].length);

  const viewHashes = {};
  for (const [name, content] of Object.entries(generateViews(map, metadata))) {
    const filtered = filterSensitive(content);
    outputs[name] = filtered;
    viewHashes[name] = sha256Hex(filtered);
  }
  outputs["context.json"] = filterSensitive(
    JSON.stringify(buildContextJson(metadata, viewHashes, diagnostics), null, 2)
  );

  let upgradedConfig = null;
  if (config) {
    upgradedConfig = { ...config, version: PROTOCOL_VERSION };
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
    reason: `legacy handoff format (pre-v${PROTOCOL_VERSION})`,
    map,
    valid,
    diagnostics,
    sourceFiles,
    metadata,
    config: upgradedConfig,
    outputs,
  };
}

// ── Apply (atomic) ───────────────────────────────────────────────────────────

function sanitizeTimestamp(timestamp) {
  return String(timestamp).replace(/[:.]/g, "-");
}

/** Pure output validation — runs before any filesystem operation. */
function validateOutputs(plan) {
  const outputs = plan.outputs || {};
  const mapContent = outputs[CONTEXT_MAP_FILE];
  if (typeof mapContent !== "string") {
    throw new Error("migration plan is invalid: missing context-map.md output");
  }
  const parsed = parseContextMap(mapContent);
  const nodeCount = (m) => SECTION_KEYS.reduce((n, key) => n + (m.sections[key] || []).length, 0);
  if (!parsed || !plan.map || nodeCount(parsed) !== nodeCount(plan.map)) {
    throw new Error("migration plan is invalid: context-map.md output fails the production parser");
  }
  for (const name of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
    if (typeof outputs[name] !== "string" || !outputs[name].startsWith(GENERATED_MARKER)) {
      throw new Error(`migration plan is invalid: ${name} output is missing or unmarked`);
    }
  }
  let contextJson;
  try {
    contextJson = JSON.parse(outputs["context.json"]);
  } catch {
    throw new Error("migration plan is invalid: context.json output is not valid JSON");
  }
  if (contextJson.version !== PROTOCOL_VERSION || !contextJson.views || !contextJson.diagnostics) {
    throw new Error("migration plan is invalid: context.json output is not a v2 context file");
  }
  if (outputs[CONFIG_OUTPUT_NAME] != null) {
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(outputs[CONFIG_OUTPUT_NAME]);
    } catch {
      throw new Error("migration plan is invalid: .handoff.config.json output is not valid JSON");
    }
    const validation = validateProjectConfig(parsedConfig);
    if (!validation.valid) {
      throw new Error(`migration plan is invalid: config output rejected: ${validation.errors.join("; ")}`);
    }
  }
}

/**
 * Apply a migration plan atomically.
 *
 * `paths`: { handoffDir, configPath? }.
 * `io`: runtime-injected filesystem adapter —
 *   { readFile(path), writeFile(path, content), rename(from, to),
 *     mkdir(path), exists(path), remove(path) } (all may be async).
 *   `remove` is required: the rename phase keeps rollback siblings of the
 *   originals and restores them on failure.
 * `options.timestamp` fixes the backup directory name (defaults to the
 * current UTC time); tests pass a fixed value for determinism.
 *
 * Sequence: validate plan → write temp files → re-validate temp files →
 * back up originals (filtered) under `.handoff/history/migrations/<UTC>/` →
 * rename data files into place → rename the config (version upgrade) last.
 * Before each final rename the existing original (if any) is moved to a
 * `<final>.migration-rollback` sibling; on ANY rename-phase failure every
 * already-replaced file is restored from its sibling (files without an
 * original are removed), so originals end up byte-identical and no mixed
 * legacy/v2 state remains. Rollback siblings are removed on success.
 * Returns `{ migrated, backupDir?, written?, reason? }`.
 */
export async function applyMigration(plan, paths, io, options = {}) {
  if (!plan || !plan.needed) {
    return { migrated: false, reason: (plan && plan.reason) || "nothing to migrate" };
  }
  if (!paths || !paths.handoffDir) throw new Error("applyMigration requires paths.handoffDir");
  if (!io) throw new Error("applyMigration requires an io adapter");
  if (typeof io.remove !== "function") throw new Error("applyMigration requires io.remove for rename-phase rollback");
  if (!plan.valid) throw new Error("migration plan failed validation; refusing to write");

  // Validate every output before touching the filesystem.
  validateOutputs(plan);

  const handoffDir = paths.handoffDir;
  const configPath = paths.configPath;
  const outputs = plan.outputs;
  const backupDir = `${handoffDir}/history/migrations/${sanitizeTimestamp(options.timestamp || new Date().toISOString())}`;

  const temps = []; // { name, tempPath, finalPath }
  const replaced = []; // { finalPath, rollbackPath } — rename-phase rollback state
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
      validateOutputs({ map: plan.map, outputs: { ...outputs, [temp.name]: written } });
    }

    // 3. Back up the originals (sensitive-data filtered) before replacing.
    await io.mkdir(backupDir);
    for (const name of HANDOFF_FILES) {
      const original = `${handoffDir}/${name}`;
      if (await io.exists(original)) {
        await io.writeFile(`${backupDir}/${name}`, filterSensitive(await io.readFile(original)));
      }
    }
    if (configPath && (await io.exists(configPath))) {
      await io.writeFile(`${backupDir}/${CONFIG_OUTPUT_NAME}`, filterSensitive(await io.readFile(configPath)));
    }

    // 4. Rename data files into place; the version upgrade renames last.
    //    Each existing original first moves to a rollback sibling so any
    //    failure mid-phase can restore every already-replaced file.
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
    // Success: drop the rollback siblings.
    for (const entry of replaced) {
      if (entry.rollbackPath) await io.remove(entry.rollbackPath);
    }
  } catch (err) {
    // Roll back the rename phase: restore every replaced original and drop
    // new files that had no original, so no mixed legacy/v2 state survives.
    for (const entry of replaced.reverse()) {
      try {
        if (await io.exists(entry.finalPath)) await io.remove(entry.finalPath);
        if (entry.rollbackPath) await io.rename(entry.rollbackPath, entry.finalPath);
      } catch {
        // Best effort: keep restoring the remaining files.
      }
    }
    // Best-effort cleanup of temporary files; originals were not renamed yet
    // or have been rolled back above.
    for (const temp of temps) {
      try {
        if (io.remove) await io.remove(temp.tempPath);
      } catch {
        // Already renamed or never written: nothing to clean.
      }
    }
    throw err;
  }

  return { migrated: true, backupDir, written: Object.keys(outputs) };
}

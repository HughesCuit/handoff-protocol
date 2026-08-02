// @ts-nocheck
/**
 * Handoff Protocol v2.1 — Context Compiler.
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/load.ts) and the Node.js implementation (scripts/node/load.mjs).
 * It intentionally uses no runtime-specific APIs (no `Deno.*`, no `node:*`)
 * and no tokenizer dependencies: selection is deterministic keyword-overlap
 * scoring over the parsed Context Map.
 *
 * Public interface (see `/handoff load --help` in SKILL.md):
 *
 *   /handoff load [auto|merge] [--focus "current task"] [--budget N] [--full]
 *
 *   --budget  estimated token limit; defaults to DEFAULT_BUDGET (4000) and is
 *             rejected below MIN_BUDGET (512).
 *   --full    overrides focus and budget: the entire Map is returned.
 *   --focus   keyword source. The Skill passes the current user request; the
 *             standalone CLIs fall back to Current Goal plus active Tasks.
 *
 * Compiler contract:
 *   - Core nodes are always included: Current Goal, Current Status,
 *     incomplete Tasks, and high-severity Risks (text starting `**high**`).
 *   - Other nodes are scored by normalized keyword overlap across the node
 *     text and its ancestor path: score = matched / total focus keywords,
 *     where matching is case-insensitive substring containment of keywords
 *     (letter/number runs of length >= 2). A node matches reliably at
 *     score >= RELIABLE_MATCH_THRESHOLD (0.5).
 *   - Every ancestor of a selected node is included.
 *   - The compiled Map preserves original section and node order.
 *   - When no non-core node matches reliably, the full Map is returned and
 *     `fallbackReason` explains why.
 *   - Core nodes are never dropped to satisfy the budget; `overflow` is
 *     reported instead. Reliable non-core nodes are added in
 *     score-descending, document-order tie-broken order while they fit.
 *
 * Return shape:
 *   { map, selectedPaths, omittedCount, estimatedTokens, overflow, fallbackReason }
 *   - map:           the compiled Context Map (full/fallback returns the input)
 *   - selectedPaths: ["goal[0]", "tasks[1]", ...] in document order
 *   - omittedCount:  nodes left out (0 for full/fallback)
 *   - estimatedTokens: sum of estimateTokens() over selected node text
 *   - overflow:      estimatedTokens exceeded the budget (core is kept anyway)
 *   - fallbackReason: null, or why the full Map was returned
 *
 * Token estimate (deterministic, documented): CJK characters count 1/1.5
 * tokens each, all other characters 1/4, rounded up.
 */

import { SECTION_KEYS } from "./context-map.mjs";

export const DEFAULT_BUDGET = 4000;
export const MIN_BUDGET = 512;
/** Normalized overlap at or above which a non-core node matches reliably. */
export const RELIABLE_MATCH_THRESHOLD = 0.5;

// CJK Unified Ideographs (+ Ext-A), Hiragana/Katakana, Hangul syllables,
// CJK compatibility ideographs, and CJK punctuation/fullwidth forms.
const CJK_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;

/**
 * Deterministic token estimate: CJK characters / 1.5 plus all other
 * characters / 4, rounded up.
 */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of String(text)) {
    if (CJK_RE.test(char)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** Validate a --budget value; throws RangeError naming the budget. */
export function validateBudget(budget) {
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < MIN_BUDGET) {
    throw new RangeError(
      `Invalid budget: expected an integer >= ${MIN_BUDGET}, got ${JSON.stringify(budget)}`
    );
  }
  return budget;
}

const HIGH_SEVERITY_RE = /^\*\*high\*\*\s+/i;

/** Core nodes: goal, status, incomplete tasks, high-severity risks. */
function isCoreNode(sectionKey, node) {
  if (sectionKey === "goal" || sectionKey === "status") return true;
  if (sectionKey === "tasks") return !node.checked;
  if (sectionKey === "risks") return HIGH_SEVERITY_RE.test(node.text);
  return false;
}

/** Focus keywords: unique letter/number runs of length >= 2, lowercased. */
function extractKeywords(focus) {
  const words = String(focus || "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
  return [...new Set(words)];
}

/** Indexes of the ancestor chain of nodes[i], nearest ancestor last. */
function ancestorIndexes(nodes, i) {
  const chain = [];
  let depth = Math.max(0, Number(nodes[i].depth) || 0);
  for (let j = i - 1; j >= 0 && depth > 0; j--) {
    const d = Math.max(0, Number(nodes[j].depth) || 0);
    if (d < depth) {
      chain.unshift(j);
      depth = d;
    }
  }
  return chain;
}

/** Flatten a parsed map into [{ key, index, node, path }] in document order. */
function flattenMap(map) {
  const entries = [];
  for (const key of SECTION_KEYS) {
    (map.sections[key] || []).forEach((node, index) => {
      entries.push({ key, index, node, path: `${key}[${index}]` });
    });
  }
  return entries;
}

function result(map, selectedPaths, omittedCount, estimatedTokens, overflow, fallbackReason) {
  return { map, selectedPaths, omittedCount, estimatedTokens, overflow, fallbackReason };
}

/** Select everything (used by --full and by the no-reliable-match fallback). */
function fullResult(entries, map, overflow, fallbackReason) {
  const tokens = entries.reduce((sum, e) => sum + estimateTokens(e.node.text), 0);
  return result(
    map,
    entries.map((e) => e.path),
    0,
    tokens,
    overflow,
    fallbackReason
  );
}

/**
 * Compile a parsed Context Map down to the nodes relevant to `options.focus`
 * within an estimated token budget.
 *
 * options: { focus?: string, budget?: number, full?: boolean }
 * Throws RangeError for budgets below MIN_BUDGET and TypeError for a
 * missing/malformed map.
 */
export function compileV2Context(map, options = {}) {
  if (!map || !map.sections) {
    throw new TypeError("compileContext requires a parsed context map");
  }
  const budget = options.budget == null ? DEFAULT_BUDGET : validateBudget(options.budget);
  const entries = flattenMap(map);

  // --full overrides focus and budget.
  if (options.full) return fullResult(entries, map, false, null);

  // Required set: core nodes plus every ancestor of a core node.
  const required = new Set();
  for (const e of entries) {
    if (!isCoreNode(e.key, e.node)) continue;
    required.add(e.path);
    const nodes = map.sections[e.key];
    for (const a of ancestorIndexes(nodes, e.index)) required.add(`${e.key}[${a}]`);
  }

  const nonCore = entries.filter((e) => !required.has(e.path));
  const keywords = extractKeywords(options.focus);

  if (keywords.length === 0) {
    // No usable focus: nothing can be scored, so the full Map is the answer.
    if (nonCore.length === 0) return fullResult(entries, map, false, null);
    const tokens = entries.reduce((sum, e) => sum + estimateTokens(e.node.text), 0);
    return fullResult(entries, map, tokens > budget, "no usable focus keywords; returned the full map");
  }

  // Score non-core nodes by normalized keyword overlap across node text and
  // ancestor paths (case-insensitive substring containment).
  const scored = nonCore.map((e) => {
    const nodes = map.sections[e.key];
    const haystack = [
      ...ancestorIndexes(nodes, e.index).map((a) => nodes[a].text),
      e.node.text,
    ].join(" ").toLowerCase();
    const matched = keywords.filter((k) => haystack.includes(k)).length;
    return { entry: e, score: matched / keywords.length };
  });

  // Reliable matches first (score desc), ties broken by document order
  // (Array.prototype.sort is stable and `scored` is in document order).
  const candidates = scored
    .filter((s) => s.score >= RELIABLE_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score); // stable sort: ties keep document order

  if (candidates.length === 0 && nonCore.length > 0) {
    const tokens = entries.reduce((sum, e) => sum + estimateTokens(e.node.text), 0);
    return fullResult(entries, map, tokens > budget, "no non-core node matched the focus reliably; returned the full map");
  }

  // Budget fill: core is never dropped; overflow is reported instead.
  const selected = new Set(required);
  let used = 0;
  for (const e of entries) if (required.has(e.path)) used += estimateTokens(e.node.text);

  for (const { entry } of candidates) {
    const nodes = map.sections[entry.key];
    const pending = [entry, ...ancestorIndexes(nodes, entry.index).map((a) => ({ key: entry.key, node: nodes[a], path: `${entry.key}[${a}]` }))]
      .filter((e) => !selected.has(e.path));
    const cost = pending.reduce((sum, e) => sum + estimateTokens(e.node.text), 0);
    if (used + cost > budget) continue; // does not fit; try smaller matches
    for (const e of pending) selected.add(e.path);
    used += cost;
  }

  // Prune the map, preserving original section and node order. Unknown
  // sections (extras) are not scorable nodes and are omitted from focused
  // output; they survive in full/fallback results.
  const pruned = { sections: {}, extras: [] };
  for (const key of SECTION_KEYS) {
    pruned.sections[key] = (map.sections[key] || []).filter((_, i) => selected.has(`${key}[${i}]`));
  }

  const selectedPaths = entries.filter((e) => selected.has(e.path)).map((e) => e.path);
  return result(pruned, selectedPaths, entries.length - selectedPaths.length, used, used > budget, null);
}

// ── v3 effort-aware compilation ──────────────────────────────────────────────
// v3 compiles the canonical state (directory + bodies). Selection follows the
// same deterministic rules as v2 — core nodes (Current Goal, Current Status,
// incomplete Tasks, high-severity Risks) are always kept, other nodes score
// by normalized keyword overlap across label, summary, body, and ancestor
// labels — but reports stable node IDs instead of positional paths, and the
// compiled result carries body entries at the requested effort:
//
//   min  — directory only; no bodies.
//   low  — selected nodes plus first-paragraph summaries.
//   med  — selected nodes plus complete bodies (default).
//   high — selected nodes, their ancestors, and their direct subtrees with
//          complete bodies.
//   max  — the complete Map and all body entries.
//
// Effort controls compilation, never persistence. Without an explicit
// --budget there is no hidden hard token cap. With an explicit budget the
// compiler preserves the Map, Current Goal, Current Status, active Tasks,
// and high-severity Risks first, then degrades full bodies to summaries
// before omitting lower-scored bodies (directory-only) — every degradation
// is reported, paragraphs are never split mid-character, and core nodes are
// never dropped (overflow is reported instead).

import { V3_SECTION_KEYS } from "./context-map.mjs";

/** Per-load effort levels, cheapest first. */
export const EFFORT_LEVELS = Object.freeze(["min", "low", "med", "high", "max"]);

/** Validate an --effort value; throws RangeError naming the effort. */
export function validateEffort(value) {
  if (typeof value !== "string" || !EFFORT_LEVELS.includes(value)) {
    throw new RangeError(
      `Invalid effort: expected one of ${EFFORT_LEVELS.join(", ")}, got ${JSON.stringify(value)}`
    );
  }
  return value;
}

function v3EntryFor(content, key, id) {
  for (const entry of (content && content[key]) || []) {
    if (entry.id === id) return entry;
  }
  return null;
}

function isCoreV3Node(key, node) {
  if (key === "goals" || key === "status") return true;
  if (key === "tasks") return !node.checked;
  if (key === "risks") return node.severity === "high";
  return false;
}

function flattenV3(state) {
  const entries = [];
  for (const key of V3_SECTION_KEYS) {
    ((state.map && state.map.sections && state.map.sections[key]) || []).forEach((node, index) => {
      entries.push({
        key,
        index,
        node,
        id: node.id,
        core: isCoreV3Node(key, node),
        body: node.id != null ? v3EntryFor(state.content, key, node.id) : null,
      });
    });
  }
  return entries;
}

/** Token cost of one entry at a materialization level ("full"|"summary"|"directory"). */
function v3NodeTokens(entry, level) {
  if (level === "directory") return estimateTokens(entry.node.label);
  const body = entry.body || { summary: "", body: "" };
  if (level === "summary") return estimateTokens(`${entry.node.label}\n${body.summary}`);
  return estimateTokens(`${entry.node.label}\n${body.summary}\n${body.body}`);
}

/**
 * Compile a canonical v3 state down to the nodes relevant to `focus` at the
 * requested effort, within an optional explicit token budget.
 *
 * Returns `{ state: { map, content }, selectedIds, omittedCount,
 * estimatedTokens, effort, overflow, fallbackReason, degradations }` where
 * `degradations` lists `{ id, from, to }` steps ("body" → "summary" →
 * "directory") forced by the budget. Throws RangeError for an invalid effort
 * or budget and TypeError for a missing/malformed state.
 */
export function compileV3Context({ state, focus, effort = "med", budget, full = false } = {}) {
  const level = validateEffort(effort);
  if (!state || !state.map || !state.map.sections) {
    throw new TypeError("compileV3Context requires a canonical v3 state");
  }
  const hasBudget = budget != null;
  const limit = hasBudget ? validateBudget(budget) : null;
  const entries = flattenV3(state);
  const allIds = entries.map((e) => e.id).filter((id) => id != null);

  // ── Selection ────────────────────────────────────────────────────────────
  const selected = new Set();
  const scores = new Map(); // id -> reliability score (non-core only)
  let fallbackReason = null;

  const addWithAncestors = (entry) => {
    if (entry.id != null) selected.add(entry.id);
    const nodes = state.map.sections[entry.key];
    for (const a of ancestorIndexes(nodes, entry.index)) {
      const ancestor = nodes[a];
      if (ancestor.id != null) selected.add(ancestor.id);
    }
  };

  if (full || level === "max") {
    for (const id of allIds) selected.add(id);
  } else {
    for (const e of entries) if (e.core) addWithAncestors(e);

    const nonCore = entries.filter((e) => e.id != null && !selected.has(e.id));
    const keywords = extractKeywords(focus);

    if (keywords.length === 0) {
      if (nonCore.length > 0) {
        for (const id of allIds) selected.add(id);
        fallbackReason = "no usable focus keywords; returned the full map";
      } else {
        for (const id of allIds) selected.add(id);
      }
    } else {
      const scored = nonCore.map((e) => {
        const nodes = state.map.sections[e.key];
        const body = e.body || { summary: "", body: "" };
        const haystack = [
          ...ancestorIndexes(nodes, e.index).map((a) => nodes[a].label),
          e.node.label,
          body.summary,
          body.body,
        ].join(" ").toLowerCase();
        const matched = keywords.filter((k) => haystack.includes(k)).length;
        return { entry: e, score: matched / keywords.length };
      });

      const candidates = scored
        .filter((s) => s.score >= RELIABLE_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      if (candidates.length === 0 && nonCore.length > 0) {
        for (const id of allIds) selected.add(id);
        fallbackReason = "no non-core node matched the focus reliably; returned the full map";
      } else {
        for (const { entry, score } of candidates) {
          scores.set(entry.id, score);
          addWithAncestors(entry);
        }
      }
    }

    // high: pull the direct subtrees of every selected node into the
    // selection (ancestors are already included by addWithAncestors).
    if (level === "high" && !fallbackReason) {
      for (const e of entries) {
        if (e.id == null || selected.has(e.id)) continue;
        const nodes = state.map.sections[e.key];
        const parents = ancestorIndexes(nodes, e.index);
        const directParent = parents.length > 0 ? nodes[parents[parents.length - 1]] : null;
        if (directParent && directParent.id != null && selected.has(directParent.id)) {
          selected.add(e.id);
        }
      }
    }
  }

  // ── Materialization ──────────────────────────────────────────────────────
  // levelAt[id] = "full" | "summary" | "directory" (min starts directory-only;
  // low starts at summary; med/high/max start at full).
  const startLevel = level === "min" ? "directory" : level === "low" ? "summary" : "full";
  const levelAt = new Map();
  for (const e of entries) {
    if (e.id != null && selected.has(e.id)) levelAt.set(e.id, startLevel);
  }

  const totalTokens = () =>
    entries.reduce((sum, e) => (e.id != null && levelAt.has(e.id) ? sum + v3NodeTokens(e, levelAt.get(e.id)) : sum), 0);

  const degradations = [];
  if (hasBudget && totalTokens() > limit) {
    // Degradation order: lowest-scored non-core first, core last; document
    // order breaks ties. Every step is reported.
    const ordered = entries
      .filter((e) => e.id != null && levelAt.has(e.id))
      .map((e) => ({ entry: e, score: e.core ? Infinity : scores.get(e.id) ?? 0 }))
      .sort((a, b) => a.score - b.score || a.entry.key.localeCompare(b.entry.key) || a.entry.index - b.entry.index);

    if (startLevel === "full") {
      for (const { entry } of ordered) {
        if (totalTokens() <= limit) break;
        if (levelAt.get(entry.id) !== "full") continue;
        if (!entry.body || !entry.body.body) continue;
        levelAt.set(entry.id, "summary");
        degradations.push({ id: entry.id, from: "body", to: "summary" });
      }
    }
    if (totalTokens() > limit && startLevel !== "min") {
      for (const { entry } of ordered) {
        if (totalTokens() <= limit) break;
        if (levelAt.get(entry.id) === "directory") continue;
        const from = levelAt.get(entry.id) === "full" ? "body" : "summary";
        if (from === "body" && (!entry.body || (!entry.body.summary && !entry.body.body))) continue;
        if (from === "summary" && (!entry.body || !entry.body.summary)) continue;
        levelAt.set(entry.id, "directory");
        degradations.push({ id: entry.id, from, to: "directory" });
      }
    }
  }

  // ── Pruned output ────────────────────────────────────────────────────────
  const prunedMap = { sections: {}, extras: [] };
  const prunedContent = {};
  for (const key of V3_SECTION_KEYS) {
    prunedMap.sections[key] = (state.map.sections[key] || []).filter((n) => n.id != null && selected.has(n.id));
    if (level === "min") {
      prunedContent[key] = [];
    } else {
      prunedContent[key] = ((state.content && state.content[key]) || [])
        .filter((e) => selected.has(e.id) && levelAt.get(e.id) !== "directory")
        .map((e) => (levelAt.get(e.id) === "summary" ? { ...e, body: "" } : e));
    }
  }

  const selectedIds = entries.filter((e) => e.id != null && selected.has(e.id)).map((e) => e.id);
  const omittedCount = entries.filter((e) => e.id != null && !selected.has(e.id)).length;
  const estimatedTokens = totalTokens();

  return {
    state: { map: prunedMap, content: prunedContent },
    selectedIds,
    omittedCount,
    estimatedTokens,
    effort: level,
    overflow: hasBudget ? estimatedTokens > limit : false,
    fallbackReason,
    degradations,
  };
}

/**
 * Unified compiler entry point. A v3 call passes a single options object
 * (`{ state, focus?, effort?, budget?, full? }`); a v2 call passes a parsed
 * v2 map plus options (`compileContext(map, { focus?, budget?, full? })`).
 */
export function compileContext(input, options = {}) {
  if (input && typeof input === "object" && input.state !== undefined) {
    return compileV3Context(input);
  }
  return compileV2Context(input, options);
}

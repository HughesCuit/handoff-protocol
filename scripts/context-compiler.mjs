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
export function compileContext(map, options = {}) {
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

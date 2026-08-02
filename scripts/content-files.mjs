// @ts-nocheck
/**
 * Handoff Protocol v3 — content-file registry.
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno and Node.js
 * implementations. In v3 the full node content (summary + detail body) lives
 * in eight section-specific Markdown files under `.handoff/content/`, each
 * keyed by stable node ID. This module is the single source of truth for
 * which file belongs to which semantic section and which ID prefix a section
 * uses.
 */

import {
  V3_SECTION_KEYS,
  V3_SECTION_LABELS,
  v3SectionKeyForLabel,
} from "./context-map.mjs";

/** Subdirectory (inside the handoff dir) that holds the section body files. */
export const CONTENT_DIR = "content";

/** Section key → content file name, in deterministic section order. */
export const CONTENT_FILES = Object.freeze({
  goals: "current-goal.md",
  status: "current-status.md",
  tasks: "tasks.md",
  decisions: "decisions.md",
  questions: "open-questions.md",
  risks: "risks.md",
  notes: "knowledge-notes.md",
  excluded: "excluded.md",
});

/** Section key → immutable short-ID prefix, in deterministic section order. */
export const ID_PREFIXES = Object.freeze({
  goals: "goal",
  status: "status",
  tasks: "task",
  decisions: "decision",
  questions: "question",
  risks: "risk",
  notes: "note",
  excluded: "excluded",
});

export { V3_SECTION_KEYS, V3_SECTION_LABELS, v3SectionKeyForLabel };

/** Content file name → section key. */
export function sectionForContentFile(name) {
  for (const [key, file] of Object.entries(CONTENT_FILES)) {
    if (file === name) return key;
  }
  return null;
}

/** Relative path (from the handoff dir) of a section's content file. */
export function contentPathForSection(sectionKey) {
  const file = CONTENT_FILES[sectionKey];
  return file ? `${CONTENT_DIR}/${file}` : null;
}

/** Paths a v3 save writes and a submodule commit includes (dirs allowed). */
export const V3_TRACKED_PATHS = Object.freeze(["context-map.md", "content", "views", "context.json"]);

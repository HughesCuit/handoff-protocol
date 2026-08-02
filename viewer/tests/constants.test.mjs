import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_MAP_RELATIVE_PATH,
  MAX_SOURCE_BYTES,
  MAX_NODES,
  WATCH_DEBOUNCE_MS,
  SECTION_KEYS,
  SECTION_LABELS,
} from "../runtime/constants.mjs";

test("exposes the fixed Context Map relative path", () => {
  assert.equal(CONTEXT_MAP_RELATIVE_PATH, ".handoff/context-map.md");
});

test("defines positive size, node, and timing limits", () => {
  assert.ok(MAX_SOURCE_BYTES > 0);
  assert.ok(MAX_NODES > 0);
  assert.ok(WATCH_DEBOUNCE_MS > 0);
});

test("lists every semantic section key in display order", () => {
  assert.deepEqual(SECTION_KEYS, [
    "goal",
    "status",
    "tasks",
    "decisions",
    "questions",
    "risks",
    "knowledge",
    "excluded",
  ]);
});

test("provides a non-empty localized label array for every section key", () => {
  assert.deepEqual(Object.keys(SECTION_LABELS), SECTION_KEYS);
  for (const key of SECTION_KEYS) {
    const labels = SECTION_LABELS[key];
    assert.ok(Array.isArray(labels), "section " + key + " should have a label array");
    assert.ok(labels.length > 0, "section " + key + " should have at least one label");
  }
});

test("uses the canonical English label as the first entry for each section", () => {
  assert.equal(SECTION_LABELS.goal[0], "Current Goal");
  assert.equal(SECTION_LABELS.status[0], "Current Status");
  assert.equal(SECTION_LABELS.tasks[0], "Tasks");
  assert.equal(SECTION_LABELS.decisions[0], "Decisions");
  assert.equal(SECTION_LABELS.questions[0], "Open Questions");
  assert.equal(SECTION_LABELS.risks[0], "Risks");
  assert.equal(SECTION_LABELS.knowledge[0], "Knowledge and Notes");
  assert.equal(SECTION_LABELS.excluded[0], "Excluded");
});

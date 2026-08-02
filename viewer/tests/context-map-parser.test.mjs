import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextMapParseError,
  parseRenderTree,
} from "../runtime/context-map-parser.mjs";

const SAMPLE = `# Context Map

## 当前目标

- Ship the viewer <!-- agent --> <!-- agent-hash:00000000 -->
  - Preserve user edits

## 任务

- [ ] Build renderer
  - [x] Choose SVG
- [x] Build renderer

## 风险

- **High** Large maps

## 已排除

- Editing
`;

test("parses localized semantic sections into an ordered nested tree", () => {
  const result = parseRenderTree(SAMPLE);

  assert.equal(result.nodeCount, 7);
  assert.deepEqual(
    result.root.children.map((node) => node.section),
    ["goal", "tasks", "risks", "excluded"],
  );
  assert.equal(result.root.children[0].children[0].text, "Ship the viewer");
  assert.equal(
    result.root.children[0].children[0].children[0].text,
    "Preserve user edits",
  );
  assert.equal(result.root.children[0].children[0].origin, "user");
});

test("maps task, risk, exclusion, and valid agent metadata", () => {
  const markdown = SAMPLE.replace(
    "<!-- agent-hash:00000000 -->",
    "<!-- agent-hash:ce11dfd4 -->",
  );
  const result = parseRenderTree(markdown);
  const tasks = result.root.children.find((node) => node.section === "tasks");
  const risks = result.root.children.find((node) => node.section === "risks");
  const excluded = result.root.children.find((node) => node.section === "excluded");

  assert.equal(tasks.children[0].taskState, "open");
  assert.equal(tasks.children[0].children[0].taskState, "done");
  assert.equal(tasks.children[1].taskState, "done");
  assert.equal(risks.children[0].risk, "high");
  assert.equal(excluded.children[0].excluded, true);
});

test("produces stable distinct ids for duplicate siblings", () => {
  const first = parseRenderTree(SAMPLE);
  const second = parseRenderTree(SAMPLE);
  const tasksA = first.root.children.find((node) => node.section === "tasks");
  const tasksB = second.root.children.find((node) => node.section === "tasks");

  assert.deepEqual(
    tasksA.children.map((node) => node.id),
    tasksB.children.map((node) => node.id),
  );
  assert.notEqual(tasksA.children[0].id, tasksA.children[1].id);
});

test("rejects empty, unrecognized, and oversized node maps with stable codes", () => {
  assert.throws(
    () => parseRenderTree(""),
    (error) => error instanceof ContextMapParseError && error.code === "EMPTY",
  );
  assert.throws(
    () => parseRenderTree("# Notes\n\n- Nothing semantic"),
    (error) => error instanceof ContextMapParseError && error.code === "INVALID",
  );

  const nodes = Array.from({ length: 2_001 }, (_, index) => `- Node ${index}`).join("\n");
  assert.throws(
    () => parseRenderTree(`# Context Map\n\n## Tasks\n\n${nodes}`),
    (error) =>
      error instanceof ContextMapParseError && error.code === "TOO_MANY_NODES",
  );
});

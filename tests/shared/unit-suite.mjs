// @ts-nocheck
/**
 * Handoff Protocol v1.5 — shared unit-test suite for the Context Map module.
 *
 * Imported by BOTH the Deno suite (tests/deno/) and the Node suite
 * (tests/node/) so both runtimes run identical assertions against identical
 * fixtures. Runtime-specific glue (fixture IO, test registration) is injected.
 */

import {
  AGENT_MARKER,
  SECTION_KEYS,
  SECTION_LABELS,
  sectionKeyForLabel,
  parseContextMap,
  renderContextMap,
  reconcileContextMap,
  buildInferredSections,
  contextMapToContext,
  contextMapHasContent,
  filterSensitive,
} from "../../scripts/context-map.mjs";

// ── Minimal assertions (runtime-agnostic) ────────────────────────────────────

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

export function assertIncludes(haystack, needle, msg) {
  if (!haystack.includes(needle)) {
    throw new Error(`${msg || "missing substring"}: expected output to include ${JSON.stringify(needle)}\n--- output ---\n${haystack}`);
  }
}

export function assertNotIncludes(haystack, needle, msg) {
  if (haystack.includes(needle)) {
    throw new Error(`${msg || "unexpected substring"}: expected output NOT to include ${JSON.stringify(needle)}\n--- output ---\n${haystack}`);
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

export function defineUnitTests(test, readFixture) {
  test("parse: full English map yields all semantic sections", async () => {
    const map = parseContextMap(await readFixture("maps/full-en.md"));
    assert(map, "expected a parsed map");
    for (const key of SECTION_KEYS) {
      assert(Array.isArray(map.sections[key]), `missing section: ${key}`);
    }

    assertEqual(map.sections.goal.length, 1, "goal node count");
    assertEqual(map.sections.goal[0].text, "Ship the v1.5 context map release");
    assertEqual(map.sections.goal[0].origin, "agent");

    assertEqual(map.sections.tasks.length, 3, "task node count");
    assertEqual(map.sections.tasks[0].origin, "agent");
    assertEqual(map.sections.tasks[0].checked, false);
    assertEqual(map.sections.tasks[1].text, "Design context map format");
    assertEqual(map.sections.tasks[1].origin, "user");
    assertEqual(map.sections.tasks[1].checked, true);
    assertEqual(map.sections.tasks[2].origin, "user");

    assertEqual(map.sections.decisions.length, 2, "decision node count");
    assertEqual(map.sections.decisions[0].origin, "agent");
    assertEqual(map.sections.decisions[1].origin, "user");
    assertEqual(map.sections.excluded.length, 1, "excluded node count");
    assert(contextMapHasContent(map), "map should report content");
  });

  test("parse: localized section labels map to fixed semantic keys", async () => {
    const map = parseContextMap(await readFixture("maps/localized-zh.md"));
    assert(map, "expected a parsed map for localized labels");
    assertEqual(map.sections.goal[0].text, "发布 v1.5 上下文地图");
    assertEqual(map.sections.status[0].text, "进行中");
    assertEqual(map.sections.tasks.length, 1);
    assertEqual(map.sections.tasks[0].checked, false);
    assertEqual(map.sections.decisions[0].text, "使用共享 ESM 模块");
    assertEqual(map.sections.knowledge[0].text, "解析器支持本地化标题");
    assertEqual(map.sections.excluded[0].text, "不引入图数据库");
  });

  test("parse: malformed or empty content returns null (fallback signal)", async () => {
    assertEqual(parseContextMap(await readFixture("maps/malformed.md")), null);
    assertEqual(parseContextMap(""), null);
    assertEqual(parseContextMap("   \n  "), null);
  });

  test("render/parse: roundtrip preserves sections, text, and origins", async () => {
    const before = parseContextMap(await readFixture("maps/full-en.md"));
    const after = parseContextMap(renderContextMap(before));
    for (const key of SECTION_KEYS) {
      assertEqual(after.sections[key].length, before.sections[key].length, `node count drift in ${key}`);
      for (let i = 0; i < before.sections[key].length; i++) {
        assertEqual(after.sections[key][i].text, before.sections[key][i].text, `text drift in ${key}[${i}]`);
        assertEqual(after.sections[key][i].origin, before.sections[key][i].origin, `origin drift in ${key}[${i}]`);
      }
    }
    const rendered = renderContextMap(before);
    assertIncludes(rendered, `# Context Map`);
    assertIncludes(rendered, AGENT_MARKER);
  });

  test("render/parse: nested nodes preserve their hierarchy", async () => {
    const source = [
      "# Context Map",
      "",
      "## Tasks",
      "",
      "- [ ] Parent task",
      "  - [ ] Child task",
      "    - [x] Grandchild task",
      "",
    ].join("\n");

    const before = parseContextMap(source);
    assertEqual(before.sections.tasks[0].depth, 0);
    assertEqual(before.sections.tasks[1].depth, 1);
    assertEqual(before.sections.tasks[2].depth, 2);

    const rendered = renderContextMap(before);
    assertIncludes(rendered, "- [ ] Parent task\n  - [ ] Child task\n    - [x] Grandchild task");

    const after = parseContextMap(rendered);
    assertEqual(after.sections.tasks[0].depth, 0);
    assertEqual(after.sections.tasks[1].depth, 1);
    assertEqual(after.sections.tasks[2].depth, 2);
  });

  test("reconcile: repeated saves are idempotent (no node duplication)", async () => {
    const ctx = {
      current_goal: "Goal A",
      status: "in-progress - 2 file(s) modified",
      todos: [{ task: "Task one (a.ts:1)", priority: "high", status: "pending" }],
      next_steps: ["Do the next thing"],
      decisions: [{ title: "T", context: "", decision: "D", rationale: "" }],
      blockers: ["Blocker one"],
      risks: ["Risk one"],
      notes: "abc1234 feat: commit message",
    };
    const inferred = buildInferredSections(ctx);
    const first = renderContextMap(reconcileContextMap(null, inferred));
    const second = renderContextMap(reconcileContextMap(parseContextMap(first), inferred));
    const third = renderContextMap(reconcileContextMap(parseContextMap(second), inferred));
    assertEqual(second, first, "second save drifted from first");
    assertEqual(third, first, "third save drifted from first");
  });

  test("reconcile: user-edited nodes win over agent inference", async () => {
    const existing = parseContextMap(await readFixture("maps/user-edited.md"));
    const inferred = {
      goal: [{ text: "New inferred goal from commits" }],
      status: [{ text: "in-progress - 2 file(s) modified" }],
      tasks: [
        { text: "**high** Fix duplicate-node growth on repeated saves" },
        { text: "**medium** Brand new inferred task" },
      ],
      decisions: [],
      questions: [],
      risks: [],
      knowledge: [],
      excluded: [],
    };
    const result = reconcileContextMap(existing, inferred);

    // Singleton section: user goal is not overwritten or duplicated.
    assertEqual(result.sections.goal.length, 1, "user goal must remain the only goal node");
    assertEqual(result.sections.goal[0].text, "Stabilize the parser before adding new sections");
    assertEqual(result.sections.goal[0].origin, "user");

    // Agent-owned status node is updated by new inference.
    assertEqual(result.sections.status.length, 1);
    assertEqual(result.sections.status[0].text, "in-progress - 2 file(s) modified");
    assertEqual(result.sections.status[0].origin, "agent");

    // User task survives; agent task updated in place (no duplicate); new task appended.
    const taskTexts = result.sections.tasks.map((n) => n.text);
    assertEqual(taskTexts.length, 3, `expected 3 task nodes, got: ${JSON.stringify(taskTexts)}`);
    assert(taskTexts.includes("User-added task that must survive reconciliation"), "user task lost");
    assert(taskTexts.includes("**high** Fix duplicate-node growth on repeated saves"), "agent task not updated");
    assert(taskTexts.includes("**medium** Brand new inferred task"), "new inferred task missing");
  });

  test("reconcile: editing agent text without removing its marker transfers ownership", async () => {
    const generated = renderContextMap(reconcileContextMap(null, {
      goal: [{ text: "Original inferred goal" }],
    }));
    const edited = generated.replace("Original inferred goal", "User-edited goal");
    const parsed = parseContextMap(edited);

    assertEqual(parsed.sections.goal[0].origin, "user", "edited agent node should become user-owned");

    const result = reconcileContextMap(parsed, {
      goal: [{ text: "New inferred goal" }],
    });
    assertEqual(result.sections.goal.length, 1);
    assertEqual(result.sections.goal[0].text, "User-edited goal");
    assertEqual(result.sections.goal[0].origin, "user");
  });

  test("reconcile: semantic duplicates are not appended", async () => {
    const existing = parseContextMap(await readFixture("maps/full-en.md"));
    const inferred = {
      goal: [], status: [], tasks: [], decisions: [], questions: [], risks: [],
      knowledge: [],
      excluded: [{ text: "**high** Do not add a graph database." }],
    };
    const result = reconcileContextMap(existing, inferred);
    assertEqual(result.sections.excluded.length, 1, "duplicate of a user node was appended");
  });

  test("reconcile: sections without new inference keep existing agent nodes", async () => {
    const existing = parseContextMap(await readFixture("maps/full-en.md"));
    const inferred = {
      goal: [{ text: "Updated goal" }],
      status: [{ text: "Updated status" }],
      tasks: [], decisions: [], questions: [], risks: [], knowledge: [], excluded: [],
    };
    const result = reconcileContextMap(existing, inferred);
    // Low-verbosity style save: no task/risk inference, map content preserved.
    assertEqual(result.sections.tasks.length, 3, "tasks lost on inference-less save");
    assertEqual(result.sections.risks.length, 2, "risks lost on inference-less save");
  });

  test("security: secrets and credential-like values are filtered from map output", async () => {
    const map = parseContextMap(await readFixture("maps/with-secrets.md"));
    const rendered = filterSensitive(renderContextMap(map));
    assertNotIncludes(rendered, "ghp_0123456789abcdef0123456789abcdef0123", "GitHub token leaked");
    assertNotIncludes(rendered, "AKIAIOSFODNN7EXAMPLE", "AWS key leaked");
    assertNotIncludes(rendered, "password=hunter2", "password leaked");
    assertNotIncludes(rendered, "api_key=abcdef0123456789abcdef", "api key leaked");
    assertIncludes(rendered, "[REDACTED]");
  });

  test("labels: every localized label resolves to its semantic key", async () => {
    for (const [key, labels] of Object.entries(SECTION_LABELS)) {
      for (const label of Object.values(labels)) {
        assertEqual(sectionKeyForLabel(label), key, `label '${label}' did not resolve to '${key}'`);
      }
    }
    assertEqual(sectionKeyForLabel("current goal"), "goal", "label lookup must be case-insensitive");
    assertEqual(sectionKeyForLabel("No Such Heading"), null);
  });

  test("contextMapToContext: map semantics convert to handoff context fields", async () => {
    const map = parseContextMap(await readFixture("handoffs/map-only/.handoff/context-map.md"));
    const ctx = contextMapToContext(map);
    assertEqual(ctx.current_goal, "Ship the v1.5 context map release");
    assertEqual(ctx.status, "Map-only handoff, no legacy files present");
    assertEqual(ctx.todos.length, 2);
    assertEqual(ctx.todos[0].priority, "high");
    assertEqual(ctx.todos[0].status, "pending");
    assertEqual(ctx.todos[0].task, "Verify map-only handoffs load without context.json");
    assertEqual(ctx.todos[1].status, "completed");
    assert(ctx.risks.includes("Loaders older than v1.5 ignore the map"), "risk missing");
    assertIncludes(ctx.notes, "The map alone must be sufficient to resume work");
  });
}

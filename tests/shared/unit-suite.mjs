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
  PROTOCOL_VERSION,
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
import {
  GENERATED_MARKER,
  buildContextJson,
  generateViews,
  sha256Hex,
  viewTamperWarnings,
} from "../../scripts/views.mjs";
import { extractTodoComments } from "../../scripts/source-comments.mjs";
import { validateProjectConfig } from "../../scripts/config.mjs";

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

  // ── TODO scanner (v1.5.1) ──────────────────────────────────────────────────

  test("scanner: C-style comment tags extracted; strings, templates, markdown examples ignored", async () => {
    const results = extractTodoComments(await readFixture("scanner/comments.ts"), ".ts");
    assertEqual(JSON.stringify(results), JSON.stringify([
      { tag: "TODO", text: "real line comment", line: 7 },
      { tag: "FIXME", text: "real block comment", line: 8 },
      { tag: "HACK", text: "real tag on an inner block line", line: 19 },
      { tag: "XXX", text: "real xxx tag stays medium priority", line: 21 },
    ]));
  });

  test("scanner: Python hash comments extracted; strings and docstrings ignored", async () => {
    const results = extractTodoComments(await readFixture("scanner/comments.py"), ".py");
    assertEqual(JSON.stringify(results), JSON.stringify([
      { tag: "TODO", text: "real hash comment", line: 2 },
      { tag: "FIXME", text: "trailing real comment", line: 8 },
    ]));
  });

  test("scanner: ruby block comments, php hash comments, unterminated comments, unknown extensions", () => {
    const ruby = ["=begin", "TODO: ruby block comment", "=end", "# FIXME: ruby line"].join("\n");
    assertEqual(JSON.stringify(extractTodoComments(ruby, ".rb")), JSON.stringify([
      { tag: "TODO", text: "ruby block comment", line: 2 },
      { tag: "FIXME", text: "ruby line", line: 4 },
    ]));

    assertEqual(JSON.stringify(extractTodoComments("<?php\n# TODO: php hash comment\n", ".php")), JSON.stringify([
      { tag: "TODO", text: "php hash comment", line: 2 },
    ]));

    assertEqual(JSON.stringify(extractTodoComments("/* TODO: never closed", ".js")), JSON.stringify([
      { tag: "TODO", text: "never closed", line: 1 },
    ]));

    assertEqual(extractTodoComments("// TODO: not a scanned extension", ".md").length, 0);
  });

  // ── Configuration validation (v1.5.1) ─────────────────────────────────────

  test("config: valid portable direct and submodule fixtures pass validation", async () => {
    for (const name of ["config/direct-valid.json", "config/submodule-valid.json"]) {
      const config = JSON.parse(await readFixture(name));
      const result = validateProjectConfig(config);
      assert(result.valid, `${name} should be valid, errors: ${result.errors.join("; ")}`);
      assertEqual(result.errors.length, 0, `${name} should have no errors`);
      assertEqual(result.config, config, `${name} should echo the input config`);
    }
  });

  test("config: submodule remote keeps existing URL behavior (exempt from path/secret rules)", () => {
    for (const remote of [
      "git@github.com:USER/PROJECT-handoff.git",
      "https://github.com/USER/PROJECT-handoff.git",
      "https://user:secret-token@example.com/USER/PROJECT-handoff.git",
      "ssh://git@192.168.1.10/srv/handoff.git",
    ]) {
      const config = { version: "1.5.1", storage: { mode: "submodule", path: ".handoff", remote } };
      const result = validateProjectConfig(config);
      assert(result.valid, `remote '${remote}' should stay supported, errors: ${result.errors.join("; ")}`);
    }
  });

  test("config: home paths, Vault paths, and credentials in fixtures are rejected", async () => {
    const cases = [
      ["config/home-path.json", "storage.path"],
      ["config/vault-path.json", "adapters.obsidian.vaultPath"],
      ["config/credentials.json", "token"],
    ];
    for (const [name, field] of cases) {
      const config = JSON.parse(await readFixture(name));
      const result = validateProjectConfig(config);
      assert(!result.valid, `${name} should be invalid`);
      assert(
        result.errors.some((e) => e.includes(field)),
        `${name} errors should name '${field}', got: ${JSON.stringify(result.errors)}`
      );
    }
  });

  test("config: malformed storage modes are rejected", async () => {
    const fixture = JSON.parse(await readFixture("config/mode-invalid.json"));
    const result = validateProjectConfig(fixture);
    assert(!result.valid, "mode-invalid.json should be invalid");
    assert(result.errors.some((e) => e.includes("storage.mode")), "error should name storage.mode");

    for (const bad of [
      ["missing storage", { version: "1.5.1" }],
      ["non-object storage", { version: "1.5.1", storage: "direct" }],
      ["missing mode", { version: "1.5.1", storage: { path: ".handoff" } }],
      ["non-string mode", { version: "1.5.1", storage: { mode: 42, path: ".handoff" } }],
      ["empty mode", { version: "1.5.1", storage: { mode: "", path: ".handoff" } }],
      ["missing path", { version: "1.5.1", storage: { mode: "direct" } }],
      ["non-string path", { version: "1.5.1", storage: { mode: "direct", path: 7 } }],
      ["non-object config", "direct"],
      ["null config", null],
    ]) {
      const [label, config] = bad;
      const r = validateProjectConfig(config);
      assert(!r.valid, `${label} should be invalid`);
      assert(r.errors.length > 0, `${label} should report at least one error`);
    }
  });

  test("config: absolute, home, and parent-traversal paths are rejected wherever they appear", () => {
    const cases = [
      ["posix absolute", { version: "1.5.1", storage: { mode: "direct", path: "/var/lib/handoff" } }],
      ["macOS home absolute", { version: "1.5.1", storage: { mode: "direct", path: "/Users/alice/proj/.handoff" } }],
      ["linux home absolute", { version: "1.5.1", storage: { mode: "direct", path: "/home/alice/.handoff" } }],
      ["windows absolute", { version: "1.5.1", storage: { mode: "direct", path: "C:\\handoff" } }],
      ["tilde home", { version: "1.5.1", storage: { mode: "direct", path: "~/handoff" } }],
      ["env home", { version: "1.5.1", storage: { mode: "direct", path: "$HOME/handoff" } }],
      ["parent traversal", { version: "1.5.1", storage: { mode: "direct", path: "../shared-handoff" } }],
      ["nested absolute", { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, extra: { cacheDir: "/tmp/handoff-cache" } }],
    ];
    for (const [label, config] of cases) {
      const r = validateProjectConfig(config);
      assert(!r.valid, `${label} should be invalid`);
    }
  });

  test("config: credential-like values are rejected outside storage.remote", () => {
    const cases = [
      ["github token", { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, auth: "ghp_0123456789abcdef0123456789abcdef0123" }],
      ["aws key", { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, note: "AKIAIOSFODNN7EXAMPLE" }],
      ["password field", { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, db: "password=hunter2" }],
      ["nested secret", { version: "1.5.1", storage: { mode: "direct", path: ".handoff" }, adapters: { x: { credentials: "api_key=abcdef0123456789abcdef" } } }],
    ];
    for (const [label, config] of cases) {
      const r = validateProjectConfig(config);
      assert(!r.valid, `${label} should be invalid`);
      assert(r.errors.some((e) => /sensitive|credential|secret/i.test(e)), `${label} error should mention sensitive data, got: ${JSON.stringify(r.errors)}`);
    }
  });

  test("config: non-string version and non-string remote are rejected", () => {
    assert(!validateProjectConfig({ version: 151, storage: { mode: "direct", path: ".handoff" } }).valid);
    assert(!validateProjectConfig({ version: "1.5.1", storage: { mode: "submodule", path: ".handoff", remote: 42 } }).valid);
  });

  // ── Canonical state and generated views (v2) ──────────────────────────────

  const VIEW_METADATA = {
    timestamp: "2026-07-26T00:00:00.000Z",
    agent: "test-agent",
    project: "fixture-app",
    lang: "en",
    verbosity: "med",
    git: { branch: "feature/map", latest_commit: "abc1234", commit_message: "feat: map", is_dirty: false },
    completed: ["feat: initial commit"],
    modifiedFiles: [{ path: "src/app.ts", description: "", change_type: "modified" }],
    blockers: [],
    nextSteps: [],
  };

  const SEMANTIC_JSON_FIELDS = [
    "current_goal", "status", "completed", "modified_files", "todos",
    "blockers", "decisions", "next_steps", "risks", "notes",
  ];

  test("views: sha256Hex matches published SHA-256 vectors", () => {
    assertEqual(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assertEqual(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // Multi-byte input must be UTF-8 encoded before hashing.
    assertEqual(sha256Hex("héllo 你好"), "7b76b0849c2e9a6a397ec9fe88fcd5489626b2b3a1dc47c47958bbe59da04390");
  });

  test("views: compatibility views are reproducibly generated from the same map", async () => {
    const map = parseContextMap(await readFixture("maps/full-en.md"));
    const first = generateViews(map, VIEW_METADATA);
    const second = generateViews(map, VIEW_METADATA);

    assertEqual(
      JSON.stringify(Object.keys(first).sort()),
      JSON.stringify(["HANDOFF.md", "decisions.md", "tasks.md"]),
      "default verbosity must generate all three compatibility views"
    );
    for (const name of Object.keys(first)) {
      assertEqual(second[name], first[name], `${name} was not deterministic across calls`);
      assert(first[name].startsWith(GENERATED_MARKER), `${name} does not begin with the generated marker`);
    }

    // Semantics come from the map; machine state comes from metadata.
    assertIncludes(first["HANDOFF.md"], "Ship the v1.5 context map release");
    assertIncludes(first["HANDOFF.md"], "Implementation in progress, tests passing");
    assertIncludes(first["HANDOFF.md"], "**Branch**: feature/map");
    assertIncludes(first["HANDOFF.md"], "- `src/app.ts` [modified]");
    assertIncludes(first["HANDOFF.md"], "- Map growth may bloat load context");
    assertIncludes(first["tasks.md"], "# Pending Tasks");
    assertIncludes(first["decisions.md"], "# Architecture Decisions");
    assertIncludes(first["decisions.md"], "Shared ESM module keeps Deno and Node behavior identical");
  });

  test("views: task state and priorities flow from the map into the task view", async () => {
    const map = parseContextMap(await readFixture("maps/full-en.md"));
    const views = generateViews(map, VIEW_METADATA);
    const tasksMd = views["tasks.md"];

    const high = tasksMd.match(/## High Priority\n([\s\S]*?)\n\n## Medium/)[1];
    const medium = tasksMd.match(/## Medium Priority\n([\s\S]*?)\n\n## Low/)[1];
    assertIncludes(high, "- [ ] Add fixture-based tests for both runtimes");
    assertNotIncludes(high, "Design context map format");
    // Checked state and default (medium) priority come from the map.
    assertIncludes(medium, "- [x] Design context map format");
    assertIncludes(medium, "- [ ] Write the migration guide");
  });

  test("views: low verbosity generates only the HANDOFF.md view", async () => {
    const map = parseContextMap(await readFixture("maps/full-en.md"));
    const views = generateViews(map, VIEW_METADATA, { verbosity: "low" });
    assertEqual(JSON.stringify(Object.keys(views)), JSON.stringify(["HANDOFF.md"]));
    assert(views["HANDOFF.md"].startsWith(GENERATED_MARKER));
  });

  test("views: empty map sections produce documented placeholder content", () => {
    const views = generateViews(null, VIEW_METADATA);
    assertIncludes(views["HANDOFF.md"], "No explicit goal set.");
    assertIncludes(views["HANDOFF.md"], "No pending tasks.");
    assertIncludes(views["decisions.md"], "No decisions recorded.");
    assertIncludes(views["tasks.md"], "None");
  });

  test("views: v2 context.json carries only metadata, view hashes, and diagnostics", () => {
    const json = buildContextJson(VIEW_METADATA, { "HANDOFF.md": "deadbeef" });
    for (const field of SEMANTIC_JSON_FIELDS) {
      assert(!(field in json), `semantic field '${field}' must not appear in v2 context.json`);
    }
    assertEqual(json.version, PROTOCOL_VERSION);
    assertEqual(json.timestamp, VIEW_METADATA.timestamp);
    assertEqual(json.agent, "test-agent");
    assertEqual(json.project, "fixture-app");
    assertEqual(json.lang, "en");
    assertEqual(json.git.branch, "feature/map");
    assertEqual(json.views["HANDOFF.md"], "deadbeef");
    assertEqual(JSON.stringify(json.diagnostics), JSON.stringify({ migration: [], conflicts: [] }));
  });

  test("views: tamper warnings fire on manual edits, never on matching or missing views", () => {
    const stored = { "HANDOFF.md": sha256Hex("original"), "tasks.md": sha256Hex("tasks") };

    // Untouched views: no warnings.
    assertEqual(viewTamperWarnings(stored, { "HANDOFF.md": "original", "tasks.md": "tasks" }).length, 0);

    // Manually edited view: exactly one warning naming the file.
    const warnings = viewTamperWarnings(stored, { "HANDOFF.md": "manually edited", "tasks.md": "tasks" });
    assertEqual(warnings.length, 1);
    assertIncludes(warnings[0], "HANDOFF.md");
    assertIncludes(warnings[0], "context-map.md");

    // Missing views are regenerated silently; only mismatches warn.
    assertEqual(viewTamperWarnings(stored, { "tasks.md": "tasks" }).length, 0);
    assertEqual(viewTamperWarnings(null, { "HANDOFF.md": "anything" }).length, 0);
  });
}

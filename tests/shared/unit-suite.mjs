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
import {
  MIGRATION_CONFLICT_LABEL,
  applyMigration,
  isMigrationNeeded,
  planMigration,
} from "../../scripts/migrate.mjs";
import {
  DEFAULT_BUDGET,
  MIN_BUDGET,
  compileContext,
  estimateTokens,
} from "../../scripts/context-compiler.mjs";
import {
  linkPathFor,
  obsidianLink,
  obsidianStatus,
  obsidianUnlink,
  resolveAlias,
  userConfigPath,
  validateAlias,
  validateVaultPath,
} from "../../scripts/adapters/obsidian.mjs";

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

export async function assertRejects(fn, msg) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg || "expected the promise to reject, but it resolved");
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

  // ── Legacy migration (v2) ───────────────────────────────────────────────

  async function readHandoffInputs(name) {
    const read = async (rel) => {
      try {
        return await readFixture(`handoffs/${name}/${rel}`);
      } catch {
        return undefined;
      }
    };
    return {
      config: await read(".handoff.config.json"),
      contextJson: await read(".handoff/context.json"),
      handoffMd: await read(".handoff/HANDOFF.md"),
      tasksMd: await read(".handoff/tasks.md"),
      decisionsMd: await read(".handoff/decisions.md"),
      contextMapMd: await read(".handoff/context-map.md"),
    };
  }

  function makeFakeIo(seed, failOn) {
    const store = new Map(Object.entries(seed));
    const ops = [];
    return {
      store,
      ops,
      readFile: async (p) => {
        if (!store.has(p)) throw new Error(`ENOENT: ${p}`);
        return store.get(p);
      },
      writeFile: async (p, content) => {
        ops.push(["write", p]);
        if (failOn && failOn(p)) throw new Error("injected write failure");
        store.set(p, content);
      },
      rename: async (from, to) => {
        ops.push(["rename", from, to]);
        if (!store.has(from)) throw new Error(`ENOENT: ${from}`);
        store.set(to, store.get(from));
        store.delete(from);
      },
      mkdir: async (p) => {
        ops.push(["mkdir", p]);
      },
      exists: async (p) => store.has(p),
      remove: async (p) => {
        ops.push(["remove", p]);
        store.delete(p);
      },
    };
  }

  const MIGRATE_HANDOFF_DIR = "/proj/.handoff";
  const MIGRATE_CONFIG_PATH = "/proj/.handoff.config.json";

  function seedFromInputs(inputs) {
    const seed = {};
    if (inputs.config != null) seed[MIGRATE_CONFIG_PATH] = inputs.config;
    if (inputs.contextJson != null) seed[`${MIGRATE_HANDOFF_DIR}/context.json`] = inputs.contextJson;
    if (inputs.handoffMd != null) seed[`${MIGRATE_HANDOFF_DIR}/HANDOFF.md`] = inputs.handoffMd;
    if (inputs.tasksMd != null) seed[`${MIGRATE_HANDOFF_DIR}/tasks.md`] = inputs.tasksMd;
    if (inputs.decisionsMd != null) seed[`${MIGRATE_HANDOFF_DIR}/decisions.md`] = inputs.decisionsMd;
    if (inputs.contextMapMd != null) seed[`${MIGRATE_HANDOFF_DIR}/context-map.md`] = inputs.contextMapMd;
    return seed;
  }

  function conflictChildren(map) {
    const questions = map.sections.questions;
    const idx = questions.findIndex((n) => n.text === MIGRATION_CONFLICT_LABEL);
    if (idx < 0) return null;
    return questions.slice(idx + 1).filter((n) => n.depth > 0).map((n) => n.text);
  }

  test("migrate: isMigrationNeeded classifies legacy, mixed, and v2 handoffs", () => {
    assertEqual(isMigrationNeeded({ mapPresent: false, contextVersion: "1.2.0" }), true, "legacy 1.x");
    assertEqual(isMigrationNeeded({ mapPresent: true, contextVersion: "1.5.0" }), true, "mixed pre-v2");
    assertEqual(isMigrationNeeded({ mapPresent: true, configVersion: "1.5.0" }), true, "map-only pre-v2");
    assertEqual(isMigrationNeeded({ mapPresent: true, contextVersion: "2.0.0" }), false, "already v2");
    assertEqual(isMigrationNeeded({ mapPresent: true, configVersion: "2.0.0" }), false, "map-only v2");
    assertEqual(isMigrationNeeded({}), false, "no data means nothing to migrate");
  });

  test("migrate: legacy-only handoff preserves task state, decision rationale, and risks", async () => {
    const plan = planMigration(await readHandoffInputs("legacy-1x"));
    assert(plan.needed, "legacy-1x should need migration");

    assertEqual(plan.map.sections.goal[0].text, "feat: add rate limiting middleware");
    assertEqual(plan.map.sections.tasks.length, 3, "legacy tasks lost or duplicated");
    assertEqual(
      plan.map.sections.tasks[0].text,
      "**high** Add Redis backend for distributed rate limiting (src/middleware/rate-limiter.ts:45)"
    );
    assert(plan.map.sections.tasks.every((n) => !n.checked), "pending task state not preserved");

    const decisions = plan.map.sections.decisions.map((n) => n.text);
    assertEqual(decisions.length, 1, "decision from decisions.md not migrated");
    assertIncludes(decisions[0], "Token bucket over leaky bucket");
    assertIncludes(decisions[0], "Use token bucket");
    assertIncludes(decisions[0], "Simpler to reason about bursty traffic", "decision rationale lost");

    const risks = plan.map.sections.risks.map((n) => n.text);
    assert(risks.includes("1 high-priority TODO/FIXME items pending"), "legacy risk lost");

    assertEqual(plan.metadata.project, "my-api");
    assertEqual(plan.metadata.git.branch, "feature/rate-limiting");
    assertEqual(plan.metadata.completed.length, 3, "completed work not carried into metadata");
    for (const f of ["context.json", "HANDOFF.md", "tasks.md", "decisions.md"]) {
      assert(plan.sourceFiles.includes(f), `sourceFiles missing '${f}'`);
    }
    assertEqual(plan.config.version, PROTOCOL_VERSION, "config version not upgraded in plan");
  });

  test("migrate: map-only handoff keeps map semantics and upgrades structure", async () => {
    const plan = planMigration(await readHandoffInputs("map-only"));
    assert(plan.needed, "map-only pre-v2 handoff should need a structural upgrade");
    assertEqual(plan.map.sections.goal[0].text, "Ship the v1.5 context map release");
    assertEqual(plan.map.sections.tasks.length, 2);
    assertEqual(plan.map.sections.tasks[1].checked, true, "completed task state lost");
    assertEqual(plan.map.sections.questions[0].text, "How should v3 rank branches?");
    assertEqual(plan.map.sections.excluded[0].text, "No vector database in v3");
    assertEqual(plan.diagnostics.conflicts.length, 0, "single-source handoff should have no conflicts");
  });

  test("migrate: map wins over legacy sources; conflicts stay visible with source labels", async () => {
    const plan = planMigration(await readHandoffInputs("conflicting"));
    assert(plan.needed, "conflicting pre-v2 handoff should need migration");

    assertEqual(plan.map.sections.goal.length, 1, "singleton goal duplicated");
    assertEqual(plan.map.sections.goal[0].text, "Ship the map-approved compiler release", "map goal must win");
    assertEqual(plan.map.sections.status[0].text, "Map status: compiler green", "map status must win");

    // Losing values stay visible below a Migration conflict node, source-labeled.
    const children = conflictChildren(plan.map);
    assert(children, "Migration conflict node missing from Open Questions");
    assertEqual(children.length, 4, `expected 4 conflict children, got: ${JSON.stringify(children)}`);
    assert(children.includes("goal: JSON draft goal superseded by the map (source: context.json)"));
    assert(children.includes("goal: HANDOFF view goal superseded by the map (source: HANDOFF.md)"));
    assert(children.includes("status: json status superseded by the map (source: context.json)"));
    assert(children.includes("status: handoff view status superseded by the map (source: HANDOFF.md)"));
    assertEqual(plan.diagnostics.conflicts.length, 4, "conflict diagnostics incomplete");

    // Map questions/exclusions preserved; unique legacy tasks merged without duplication.
    assert(plan.map.sections.questions.some((n) => n.text === "How should v3 rank branches?"), "map question lost");
    assertEqual(plan.map.sections.excluded[0].text, "No vector database in v3");
    const tasks = plan.map.sections.tasks;
    const shared = tasks.filter((n) => n.text.includes("Wire the context compiler into load"));
    assertEqual(shared.length, 1, "overlapping task not deduplicated");
    assertEqual(shared[0].checked, false, "map task state lost to the legacy duplicate");
    assert(tasks.some((n) => n.text === "**medium** Legacy-only task from context.json"), "unique context.json task lost");
    assert(tasks.some((n) => n.text === "**medium** Legacy-only task from HANDOFF.md"), "unique HANDOFF.md task lost");
    const risks = plan.map.sections.risks.map((n) => n.text);
    assert(risks.includes("JSON-only risk"), "context.json risk lost");
    assert(risks.includes("HANDOFF-only risk"), "HANDOFF.md risk lost");
  });

  test("migrate: malformed context.json falls back to human-readable files with a diagnostic", async () => {
    const plan = planMigration(await readHandoffInputs("malformed"));
    assert(plan.needed, "malformed handoff should need migration");
    assert(
      plan.diagnostics.migration.some((d) => /context\.json/.test(d) && /malformed|invalid|unreadable/i.test(d)),
      `missing malformed-context.json diagnostic: ${JSON.stringify(plan.diagnostics.migration)}`
    );
    assert(!plan.sourceFiles.includes("context.json"), "malformed context.json must not count as a source");

    assertEqual(plan.map.sections.goal[0].text, "fix: repair flaky integration tests");
    const tasks = plan.map.sections.tasks;
    assertEqual(tasks.length, 2, `expected 2 tasks, got: ${JSON.stringify(tasks.map((n) => n.text))}`);
    const stabilize = tasks.find((n) => n.text.includes("Stabilize the flaky checkout test"));
    const reproduce = tasks.find((n) => n.text.includes("Reproduce the flake locally"));
    assert(stabilize && !stabilize.checked, "pending task state lost");
    assert(reproduce && reproduce.checked, "completed task state lost");
    assert(
      plan.map.sections.decisions.some((n) => n.text.includes("Real checkout behavior must stay covered")),
      "decision rationale lost"
    );
    assertEqual(plan.metadata.project, "malformed-fixture", "metadata not recovered from HANDOFF.md header");
  });

  test("migrate: partially missing handoff migrates from HANDOFF.md alone", async () => {
    const plan = planMigration(await readHandoffInputs("partial"));
    assert(plan.needed, "partial handoff should need migration");
    assertEqual(JSON.stringify(plan.sourceFiles), JSON.stringify(["HANDOFF.md"]));
    assertEqual(plan.map.sections.goal[0].text, "docs: refresh readme");
    assertEqual(plan.map.sections.tasks.length, 1);
    assertEqual(plan.map.sections.tasks[0].text, "**low** Proofread the new readme section");
    assertEqual(plan.map.sections.tasks[0].checked, false);
    assertEqual(plan.metadata.project, "partial-fixture");
    assertEqual(plan.metadata.agent, "claude-code");
  });

  test("migrate: already-migrated v2 handoff needs no migration", async () => {
    const plan = planMigration(await readHandoffInputs("migrated"));
    assert(!plan.needed, "v2 handoff must not be re-migrated");
    assert(/already/i.test(plan.reason), `unexpected reason: ${plan.reason}`);
  });

  test("migrate: proposed map validates against the production parser", async () => {
    for (const name of ["legacy-1x", "map-only", "mixed", "malformed", "conflicting", "partial"]) {
      const plan = planMigration(await readHandoffInputs(name));
      assert(plan.needed, `${name} should need migration`);
      assert(plan.valid, `${name}: proposed map failed production-parser validation`);
      const reparsed = parseContextMap(plan.outputs["context-map.md"]);
      assert(reparsed, `${name}: rendered map does not reparse`);
      for (const key of SECTION_KEYS) {
        assertEqual(
          reparsed.sections[key].length,
          plan.map.sections[key].length,
          `${name}: section '${key}' drifted through render/parse`
        );
      }
    }
  });

  test("migrate: explicit user instructions take highest precedence", async () => {
    const inputs = await readHandoffInputs("conflicting");
    const plan = planMigration(inputs, { goal: "Explicit user goal" });
    assertEqual(plan.map.sections.goal.length, 1);
    assertEqual(plan.map.sections.goal[0].text, "Explicit user goal", "user instruction must beat the map");

    const noted = planMigration(inputs, "Remember to rotate the deploy key");
    assert(
      noted.map.sections.knowledge.some((n) => n.text === "Remember to rotate the deploy key"),
      "instruction note not recorded"
    );
  });

  test("migrate: planMigration is pure and deterministic", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const before = JSON.stringify(inputs);
    const first = planMigration(inputs);
    const second = planMigration(inputs);
    assertEqual(JSON.stringify(first), JSON.stringify(second), "planMigration is not deterministic");
    assertEqual(JSON.stringify(inputs), before, "planMigration mutated its inputs");
  });

  test("migrate: applyMigration backs up originals, writes via temp files, upgrades version last", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const plan = planMigration(inputs);
    const seed = seedFromInputs(inputs);
    const io = makeFakeIo(seed);

    const result = await applyMigration(
      plan,
      { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH },
      io,
      { timestamp: "2026-07-26T00:00:00.000Z" }
    );
    assert(result.migrated, "applyMigration should report migrated");

    const backupDir = `${MIGRATE_HANDOFF_DIR}/history/migrations/2026-07-26T00-00-00-000Z`;
    assertEqual(result.backupDir, backupDir, "unexpected backup directory");
    // Originals backed up (the fixture carries no secrets, so backup is verbatim).
    assertEqual(io.store.get(`${backupDir}/HANDOFF.md`), inputs.handoffMd);
    assertEqual(io.store.get(`${backupDir}/context.json`), inputs.contextJson);
    assertEqual(io.store.get(`${backupDir}/tasks.md`), inputs.tasksMd);
    assertEqual(io.store.get(`${backupDir}/decisions.md`), inputs.decisionsMd);
    assertEqual(io.store.get(`${backupDir}/.handoff.config.json`), inputs.config);

    // Finals replaced with v2 content.
    const map = parseContextMap(io.store.get(`${MIGRATE_HANDOFF_DIR}/context-map.md`));
    assert(map, "migrated map does not parse");
    assertEqual(map.sections.tasks.length, 3);
    const json = JSON.parse(io.store.get(`${MIGRATE_HANDOFF_DIR}/context.json`));
    assertEqual(json.version, PROTOCOL_VERSION);
    assert(json.diagnostics.migration.length > 0, "migration diagnostics missing");
    assertEqual(
      json.views["HANDOFF.md"],
      sha256Hex(io.store.get(`${MIGRATE_HANDOFF_DIR}/HANDOFF.md`)),
      "stored view hash does not match the written view"
    );
    const config = JSON.parse(io.store.get(MIGRATE_CONFIG_PATH));
    assertEqual(config.version, PROTOCOL_VERSION, "config version not upgraded");

    // Version upgrade is the final rename: the config temp renames last.
    const renames = io.ops.filter((op) => op[0] === "rename");
    assert(renames.length >= 5, `expected temp-file renames, got: ${JSON.stringify(renames)}`);
    assertEqual(renames[renames.length - 1][2], MIGRATE_CONFIG_PATH, "config must be renamed after the final data rename");

    // No temp files left behind.
    for (const key of io.store.keys()) {
      assert(!key.includes("migration-tmp"), `temp file left behind: ${key}`);
    }
  });

  test("migrate: applyMigration validates the plan before touching the filesystem", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const plan = planMigration(inputs);
    plan.outputs["context-map.md"] = "garbage that is not a context map";
    const io = makeFakeIo(seedFromInputs(inputs));

    await assertRejects(
      () => applyMigration(plan, { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH }, io),
      "corrupted plan output must be rejected"
    );
    assertEqual(io.ops.length, 0, "an invalid plan must not cause any filesystem operation");
  });

  test("migrate: injected write failure leaves original files and configuration unchanged", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const plan = planMigration(inputs);
    const seed = seedFromInputs(inputs);
    const io = makeFakeIo(seed, (p) => p.endsWith("tasks.md.migration-tmp"));

    await assertRejects(
      () =>
        applyMigration(
          plan,
          { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH },
          io,
          { timestamp: "2026-07-26T00:00:00.000Z" }
        ),
      "injected write failure should abort the migration"
    );

    for (const [key, value] of Object.entries(seed)) {
      assertEqual(io.store.get(key), value, `original file changed despite failure: ${key}`);
    }
    assert(!io.store.has(`${MIGRATE_HANDOFF_DIR}/context-map.md`), "partial output left behind");
    for (const key of io.store.keys()) {
      assert(!key.includes("migration-tmp"), `temp file left behind: ${key}`);
    }
  });

  test("migrate: repeated migration is idempotent", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const io = makeFakeIo(seedFromInputs(inputs));
    const paths = { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH };

    const first = await applyMigration(planMigration(inputs), paths, io, { timestamp: "2026-07-26T00:00:00.000Z" });
    assert(first.migrated, "first migration should write");
    const snapshot = JSON.stringify([...io.store.entries()].sort());

    const secondPlan = planMigration({
      config: io.store.get(MIGRATE_CONFIG_PATH),
      contextJson: io.store.get(`${MIGRATE_HANDOFF_DIR}/context.json`),
      handoffMd: io.store.get(`${MIGRATE_HANDOFF_DIR}/HANDOFF.md`),
      tasksMd: io.store.get(`${MIGRATE_HANDOFF_DIR}/tasks.md`),
      decisionsMd: io.store.get(`${MIGRATE_HANDOFF_DIR}/decisions.md`),
      contextMapMd: io.store.get(`${MIGRATE_HANDOFF_DIR}/context-map.md`),
    });
    assert(!secondPlan.needed, `second plan should be a no-op, got: ${secondPlan.reason}`);
    const second = await applyMigration(secondPlan, paths, io, { timestamp: "2026-07-26T01:00:00.000Z" });
    assert(!second.migrated, "second migration must not write");
    assertEqual(JSON.stringify([...io.store.entries()].sort()), snapshot, "second migration changed files");
  });

  // ── Context compiler (v2.1) ────────────────────────────────────────────────

  test("compiler: token estimate follows the documented CJK-aware formula", () => {
    assertEqual(estimateTokens(""), 0);
    assertEqual(estimateTokens("abcd"), 1, "4 ASCII chars / 4");
    assertEqual(estimateTokens("abcde"), 2, "ceil(5/4)");
    assertEqual(estimateTokens("你好"), 2, "ceil(2/1.5)");
    assertEqual(estimateTokens("ab你好"), 2, "ceil(2/4 + 2/1.5)");
    assertEqual(estimateTokens("你好世界"), 3, "ceil(4/1.5)");
  });

  test("compiler: budget below the minimum or non-numeric is rejected", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    for (const bad of [MIN_BUDGET - 1, 0, -512, 512.5, NaN, "100"]) {
      let threw = false;
      try {
        compileContext(map, { budget: bad });
      } catch (err) {
        threw = true;
        assert(/budget/i.test(err.message), `error should name the budget, got: ${err.message}`);
      }
      assert(threw, `budget ${JSON.stringify(bad)} must be rejected`);
    }
  });

  test("compiler: core nodes are always included regardless of focus", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    const result = compileContext(map, { focus: "keyword overlap scoring" });
    assertEqual(result.fallbackReason, null, `unexpected fallback: ${result.fallbackReason}`);

    for (const core of ["goal[0]", "status[0]", "tasks[0]", "tasks[1]", "risks[0]"]) {
      assert(result.selectedPaths.includes(core), `core node '${core}' missing from selection`);
    }
    assert(!result.selectedPaths.includes("tasks[2]"), "completed task must not be core");
    assert(!result.selectedPaths.includes("risks[1]"), "non-high risk must not be core");
  });

  test("compiler: a relevant nested branch is selected with every ancestor", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    const result = compileContext(map, { focus: "normalization lowercases" });
    assertEqual(result.fallbackReason, null, `unexpected fallback: ${result.fallbackReason}`);
    assert(result.selectedPaths.includes("decisions[1]"), "matching nested node not selected");
    assert(result.selectedPaths.includes("decisions[0]"), "ancestor of a selected node not included");
    assert(!result.selectedPaths.includes("decisions[2]"), "unmatched sibling must stay omitted");
  });

  test("compiler: scoring spans node text and ancestor paths", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    // Neither keyword alone is reliable on the child text ("lowercases" only);
    // the ancestor path contributes "keyword", so the branch matches reliably.
    const result = compileContext(map, { focus: "keyword lowercases" });
    assertEqual(result.fallbackReason, null, "ancestor-path scoring should prevent fallback");
    assert(result.selectedPaths.includes("decisions[1]"), "branch matching via ancestor path not selected");
    assert(result.selectedPaths.includes("decisions[0]"), "ancestor not included");
  });

  test("compiler: selection is deterministic and preserves document order", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    const first = compileContext(map, { focus: "keyword overlap scoring" });
    const second = compileContext(map, { focus: "keyword overlap scoring" });
    assertEqual(JSON.stringify(first), JSON.stringify(second), "compilation is not deterministic");

    const expected = ["goal[0]", "status[0]", "tasks[0]", "tasks[1]", "decisions[0]", "decisions[1]", "risks[0]"];
    assertEqual(
      JSON.stringify(first.selectedPaths),
      JSON.stringify(expected),
      "selected paths must follow original section and node order"
    );
  });

  test("compiler: overflow is reported and core nodes are never dropped", () => {
    const bigGoal = "x".repeat(3000); // ~750 estimated tokens, over any minimal budget
    const source = [
      "# Context Map",
      "",
      "## Current Goal",
      "",
      `- ${bigGoal}`,
      "",
      "## Tasks",
      "",
      "- [ ] Small task",
      "",
    ].join("\n");
    const map = parseContextMap(source);
    const result = compileContext(map, { focus: "small task", budget: MIN_BUDGET });

    assert(result.overflow, "core exceeding the budget must report overflow");
    assert(result.selectedPaths.includes("goal[0]"), "core goal was dropped to satisfy the budget");
    assert(result.selectedPaths.includes("tasks[0]"), "core task was dropped to satisfy the budget");
    assert(result.estimatedTokens > MIN_BUDGET, "estimate should exceed the budget on overflow");
  });

  test("compiler: no reliable match falls back to the full map with a reason", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    // "scoring" matches weakly (1 of 3 keywords) — below the reliable threshold.
    const result = compileContext(map, { focus: "zebra quokka scoring" });
    assert(result.fallbackReason, "expected a fallback reason when nothing matches reliably");
    assertEqual(result.omittedCount, 0, "fallback must return the full map");
    assertEqual(result.selectedPaths.length, 13, "fallback must select every node");

    const total = compileContext(map, { full: true });
    assertEqual(
      JSON.stringify(result.selectedPaths),
      JSON.stringify(total.selectedPaths),
      "fallback selection should equal the full-map selection"
    );
  });

  test("compiler: --full overrides focus and budget", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    const result = compileContext(map, { focus: "zebra", budget: MIN_BUDGET, full: true });
    assertEqual(result.fallbackReason, null, "--full is an explicit choice, not a fallback");
    assertEqual(result.omittedCount, 0, "--full must omit nothing");
    assertEqual(result.overflow, false, "--full overrides the budget");
    assertEqual(result.selectedPaths.length, 13, "--full must select every node");
  });

  test("compiler: defaults are 4000 budget with no focus requirement", async () => {
    const map = parseContextMap(await readFixture("maps/compiler.md"));
    assertEqual(DEFAULT_BUDGET, 4000, "documented default budget changed");
    assertEqual(MIN_BUDGET, 512, "documented minimum budget changed");
    // No focus at all: nothing can match, so the full map comes back.
    const result = compileContext(map, {});
    assert(result.fallbackReason, "empty focus should fall back to the full map");
    assertEqual(result.omittedCount, 0);
  });

  // ── Obsidian adapter (v2.2) ───────────────────────────────────────────────

  // In-memory link-capable filesystem for the adapter's io seam. Directories
  // are a Set of paths, symlinks/junctions a Map of linkPath -> target.
  function makeLinkIo(seed = {}, failOn) {
    const dirs = new Set(seed.dirs || []);
    const links = new Map(Object.entries(seed.links || {}));
    const ops = [];
    return {
      dirs,
      links,
      ops,
      lstat: async (p) => {
        if (links.has(p)) return { kind: "symlink" };
        if (dirs.has(p)) return { kind: "directory" };
        return null;
      },
      exists: async (p) => dirs.has(p),
      readlink: async (p) => {
        if (!links.has(p)) throw new Error(`EINVAL: not a symlink: ${p}`);
        return links.get(p);
      },
      symlink: async (target, linkPath, opts) => {
        ops.push(["symlink", target, linkPath, opts]);
        if (failOn && failOn(linkPath)) {
          const err = new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
          err.code = "EPERM";
          throw err;
        }
        links.set(linkPath, target);
      },
      mkdir: async (p) => {
        ops.push(["mkdir", p]);
        dirs.add(p);
      },
      unlink: async (p) => {
        ops.push(["unlink", p]);
        if (!links.has(p)) throw new Error(`ENOENT: ${p}`);
        links.delete(p);
      },
    };
  }

  const VAULT = "/Users/alice/Documents/Obsidian Vault 知识库";
  const PROJECT = "/work/handoff-protocol";
  const HANDOFF_DIR = `${PROJECT}/.handoff`;

  test("obsidian: validateVaultPath accepts absolute paths, including spaces and Unicode", () => {
    for (const p of [
      VAULT,
      "/vault",
      "/vault/with spaces",
      "C:\\Users\\alice\\Vault",
      "D:/Vault/知识库",
      "\\\\NAS\\share\\Vault",
    ]) {
      const r = validateVaultPath(p);
      assert(r.valid, `'${p}' should be a valid Vault path, errors: ${r.errors.join("; ")}`);
    }
    for (const [label, p] of [
      ["empty", ""],
      ["whitespace", "   "],
      ["non-string", 42],
      ["relative", "Documents/Vault"],
      ["home-relative", "~/Vault"],
      ["parent traversal", "/vault/../vault"],
      ["windows relative", "Vault\\Notes"],
    ]) {
      const r = validateVaultPath(p);
      assert(!r.valid, `${label} ('${p}') must be rejected`);
      assert(r.errors.length > 0, `${label} should report an error`);
    }
  });

  test("obsidian: validateAlias rejects empty, separator, and traversal aliases", () => {
    for (const a of ["handoff-protocol", "my project", "项目 甲", "proj_2"]) {
      assert(validateAlias(a).valid, `'${a}' should be a valid alias`);
    }
    for (const a of ["", "   ", "..", ".", "a/b", "a\\b", "../x", 42]) {
      const r = validateAlias(a);
      assert(!r.valid, `alias '${a}' must be rejected`);
    }
  });

  test("obsidian: userConfigPath follows XDG, home fallback, and APPDATA", () => {
    assertEqual(
      userConfigPath({ XDG_CONFIG_HOME: "/cfg", HOME: "/home/alice" }, "linux"),
      "/cfg/handoff/config.json",
      "XDG_CONFIG_HOME must win on Linux"
    );
    assertEqual(
      userConfigPath({ HOME: "/Users/alice" }, "darwin"),
      "/Users/alice/.config/handoff/config.json",
      "macOS must fall back to ~/.config"
    );
    assertEqual(
      userConfigPath({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }, "win32"),
      "C:\\Users\\alice\\AppData\\Roaming\\handoff\\config.json",
      "Windows must use %APPDATA%"
    );
    const r = userConfigPath({}, "linux");
    assertEqual(r, null, "no HOME and no XDG_CONFIG_HOME should give no path");
  });

  test("obsidian: linkPathFor builds <Vault>/Projects/<alias>", () => {
    assertEqual(linkPathFor("/vault", "proj"), "/vault/Projects/proj");
    assertEqual(linkPathFor("/vault/", "proj"), "/vault/Projects/proj", "trailing separator must not duplicate");
    assertEqual(linkPathFor(VAULT, "my project"), `${VAULT}/Projects/my project`);
  });

  test("obsidian: resolveAlias prefers explicit flag, then project config, then directory name", () => {
    assertEqual(resolveAlias({ alias: "flag", projectAlias: "cfg", projectDir: "/work/dirname" }), "flag");
    assertEqual(resolveAlias({ projectAlias: "cfg", projectDir: "/work/dirname" }), "cfg");
    assertEqual(resolveAlias({ projectDir: "/work/dirname" }), "dirname");
    assertEqual(resolveAlias({ projectDir: PROJECT }), "handoff-protocol");
  });

  test("obsidian: link creates a directory symlink into the Vault", async () => {
    const io = makeLinkIo({ dirs: [VAULT, PROJECT, HANDOFF_DIR] });
    const r = await obsidianLink({ vaultPath: VAULT, alias: "my proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(r.ok, `link should succeed: ${r.message || ""}`);
    assertEqual(r.state, "linked");
    assertEqual(r.linkPath, `${VAULT}/Projects/my proj`);
    assertEqual(r.target, HANDOFF_DIR);
    assertEqual(io.links.get(r.linkPath), HANDOFF_DIR, "symlink must point at .handoff/");
    assert(io.dirs.has(`${VAULT}/Projects`), "Projects folder must be created in the Vault");
  });

  test("obsidian: link uses a junction on Windows", async () => {
    const io = makeLinkIo({ dirs: ["C:\\Vault", "C:\\proj", "C:\\proj\\.handoff"] });
    const r = await obsidianLink(
      { vaultPath: "C:\\Vault", alias: "proj", projectDir: "C:\\proj", platform: "win32" },
      io
    );
    assert(r.ok, `link should succeed: ${r.message || ""}`);
    const call = io.ops.find((op) => op[0] === "symlink");
    assert(call, "symlink must be attempted");
    assertEqual(call[3].junction, true, "Windows must request a directory junction");
  });

  test("obsidian: an existing correct link is an idempotent success", async () => {
    const linkPath = linkPathFor(VAULT, "proj");
    const io = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, PROJECT, HANDOFF_DIR],
      links: { [linkPath]: HANDOFF_DIR },
    });
    const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(r.ok, "re-linking a correct link must succeed");
    assertEqual(r.state, "already-linked");
    assert(!io.ops.some((op) => op[0] === "symlink"), "no new symlink should be created");
  });

  test("obsidian: link refuses to replace a real directory or file", async () => {
    for (const kind of ["directory", "file"]) {
      const linkPath = linkPathFor(VAULT, "proj");
      const io = makeLinkIo({ dirs: [VAULT, `${VAULT}/Projects`, PROJECT, HANDOFF_DIR] });
      const baseLstat = io.lstat;
      io.lstat = async (p) => (p === linkPath ? { kind } : baseLstat(p));
      const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
      assert(!r.ok, `a real ${kind} at the link path must be refused`);
      assertEqual(r.reason, "collision");
      assert(r.message.includes(linkPath), "message should name the conflicting path");
      assert(!io.ops.some((op) => op[0] === "symlink" || op[0] === "unlink"), "nothing may be created or removed");
    }
  });

  test("obsidian: link refuses to replace a foreign link", async () => {
    const linkPath = linkPathFor(VAULT, "proj");
    const io = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, PROJECT, HANDOFF_DIR, "/other/.handoff"],
      links: { [linkPath]: "/other/.handoff" },
    });
    const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(!r.ok, "a foreign link must be refused");
    assertEqual(r.reason, "foreign-link");
    assertEqual(io.links.get(linkPath), "/other/.handoff", "foreign link must be left untouched");
  });

  test("obsidian: link rejects an invalid Vault path before touching the filesystem", async () => {
    const io = makeLinkIo();
    const r = await obsidianLink({ vaultPath: "relative/Vault", alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(!r.ok, "relative Vault path must be refused");
    assertEqual(r.reason, "invalid-vault");
    assertEqual(io.ops.length, 0, "no filesystem operations allowed for invalid paths");
  });

  test("obsidian: link requires the Vault to be an existing directory", async () => {
    const io = makeLinkIo({ dirs: [PROJECT, HANDOFF_DIR] });
    const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(!r.ok, "missing Vault must be refused");
    assertEqual(r.reason, "vault-missing");
    assertEqual(io.links.size, 0, "no link may be created");
  });

  test("obsidian: permission failures return actionable guidance", async () => {
    const io = makeLinkIo({ dirs: [VAULT, PROJECT, HANDOFF_DIR] }, () => true);
    for (const platform of ["darwin", "win32"]) {
      const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform }, io);
      assert(!r.ok, `${platform}: EPERM must fail the link`);
      assertEqual(r.reason, "permission-denied");
      assert(r.guidance && r.guidance.length > 20, `${platform}: actionable guidance required`);
      if (platform === "win32") {
        assert(/Developer Mode|administrator|elevated/i.test(r.guidance), `windows guidance must mention Developer Mode/elevation: ${r.guidance}`);
      } else {
        assert(/writable|permission|Full Disk Access/i.test(r.guidance), `posix guidance must mention permissions: ${r.guidance}`);
      }
    }
  });

  test("obsidian: status reports linked, missing, broken, and foreign states", async () => {
    const linkPath = linkPathFor(VAULT, "proj");
    const base = { vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" };

    const linked = await obsidianStatus(base, makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR],
      links: { [linkPath]: HANDOFF_DIR },
    }));
    assertEqual(linked.state, "linked");

    const missing = await obsidianStatus(base, makeLinkIo({ dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR] }));
    assertEqual(missing.state, "missing");

    const broken = await obsidianStatus(base, makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`],
      links: { [linkPath]: HANDOFF_DIR },
    }));
    assertEqual(broken.state, "broken", "link whose target vanished must report broken");

    const foreign = await obsidianStatus(base, makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, "/other/.handoff"],
      links: { [linkPath]: "/other/.handoff" },
    }));
    assertEqual(foreign.state, "foreign-link");
    assertEqual(foreign.actualTarget, "/other/.handoff");

    const conflict = await obsidianStatus(base, makeLinkIo({ dirs: [VAULT, `${VAULT}/Projects`, linkPath, HANDOFF_DIR] }));
    assertEqual(conflict.state, "conflict", "a real directory at the link path is a conflict");
  });

  test("obsidian: unlink removes only a verified Adapter-created link", async () => {
    const linkPath = linkPathFor(VAULT, "proj");
    const io = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR],
      links: { [linkPath]: HANDOFF_DIR },
    });
    const r = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(r.ok, `unlink should succeed: ${r.message || ""}`);
    assertEqual(r.state, "unlinked");
    assert(!io.links.has(linkPath), "link must be removed");
    assert(io.dirs.has(HANDOFF_DIR), "the .handoff target must never be removed");
  });

  test("obsidian: unlink is idempotent when no link exists", async () => {
    const io = makeLinkIo({ dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR] });
    const r = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(r.ok, "unlink with nothing linked should succeed");
    assertEqual(r.state, "not-linked");
    assert(!io.ops.some((op) => op[0] === "unlink"), "nothing may be removed");
  });

  test("obsidian: unlink refuses real directories, files, and foreign links", async () => {
    const linkPath = linkPathFor(VAULT, "proj");

    const realDir = makeLinkIo({ dirs: [VAULT, `${VAULT}/Projects`, linkPath, HANDOFF_DIR] });
    const r1 = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, realDir);
    assert(!r1.ok, "unlink must refuse a real directory");
    assertEqual(r1.reason, "collision");
    assert(realDir.dirs.has(linkPath), "user directory must remain");

    const foreign = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, "/other/.handoff", HANDOFF_DIR],
      links: { [linkPath]: "/other/.handoff" },
    });
    const r2 = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, foreign);
    assert(!r2.ok, "unlink must refuse a foreign link");
    assertEqual(r2.reason, "foreign-link");
    assertEqual(foreign.links.get(linkPath), "/other/.handoff", "foreign link must remain");
    assert(!foreign.ops.some((op) => op[0] === "unlink"), "nothing may be removed");
  });

  test("config: adapters.obsidian portable shape passes validation", () => {
    const config = {
      version: "2.2.0",
      storage: { mode: "direct", path: ".handoff" },
      adapters: { obsidian: { enabled: true, projectAlias: "handoff-protocol" } },
    };
    const r = validateProjectConfig(config);
    assert(r.valid, `adapters.obsidian should be valid, errors: ${r.errors.join("; ")}`);

    const off = validateProjectConfig({
      version: "2.2.0",
      storage: { mode: "direct", path: ".handoff" },
      adapters: { obsidian: { enabled: false } },
    });
    assert(off.valid, "projectAlias is optional, errors: " + off.errors.join("; "));
  });

  test("config: malformed adapters.obsidian shapes are rejected", () => {
    const base = { version: "2.2.0", storage: { mode: "direct", path: ".handoff" } };
    const cases = [
      ["non-object adapters", { ...base, adapters: "obsidian" }],
      ["non-object obsidian", { ...base, adapters: { obsidian: true } }],
      ["non-boolean enabled", { ...base, adapters: { obsidian: { enabled: "yes" } } }],
      ["non-string projectAlias", { ...base, adapters: { obsidian: { enabled: true, projectAlias: 7 } } }],
      ["empty projectAlias", { ...base, adapters: { obsidian: { projectAlias: " " } } }],
    ];
    for (const [label, config] of cases) {
      const r = validateProjectConfig(config);
      assert(!r.valid, `${label} should be invalid`);
      assert(r.errors.some((e) => e.includes("adapters")), `${label} error should name adapters: ${JSON.stringify(r.errors)}`);
    }
  });

  test("config: Vault paths stay rejected in project config (user-level only)", () => {
    const config = {
      version: "2.2.0",
      storage: { mode: "direct", path: ".handoff" },
      adapters: { obsidian: { enabled: true, vaultPath: "/Users/alice/Documents/Vault" } },
    };
    const r = validateProjectConfig(config);
    assert(!r.valid, "Vault absolute path in project config must be rejected");
    assert(r.errors.some((e) => e.includes("adapters.obsidian.vaultPath")), `error should name the field: ${JSON.stringify(r.errors)}`);
  });
}

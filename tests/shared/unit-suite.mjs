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
  V3_PROTOCOL_VERSION,
  V3_SECTION_KEYS,
  V3_SECTION_LABELS,
  v3SectionKeyForLabel,
  emptyContextMap,
  emptyContextMapV3,
  SECTION_KEYS,
  SECTION_LABELS,
  sectionKeyForLabel,
  parseContextMap,
  parseContextMapV3,
  renderContextMap,
  renderContextMapV3,
  reconcileContextMap,
  buildInferredSections,
  contextMapToContext,
  contextMapHasContent,
  filterSensitive,
} from "../../scripts/context-map.mjs";
import {
  CONTENT_DIR,
  CONTENT_FILES,
  ID_PREFIXES,
} from "../../scripts/content-files.mjs";
import {
  NODE_ID_RE,
  allocateNodeId,
  emptyV3Content,
  indexContextMap,
  loadHandoffState,
  parseContentFile,
  reconcileV3State,
  recoverIdCounters,
  renderContentFile,
  validateHandoffState,
} from "../../scripts/handoff-state.mjs";
import {
  GENERATED_MARKER,
  V3_GENERATED_MARKER,
  buildContextJson,
  buildInitialV3Files,
  buildV3ContextJson,
  generateV3Views,
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
  SNAPSHOT_DIR,
  SNAPSHOT_RETENTION,
  buildSnapshot,
  snapshotDigest,
  writeSnapshot,
} from "../../scripts/snapshots.mjs";
import {
  DEFAULT_BUDGET,
  MIN_BUDGET,
  compileContext,
  estimateTokens,
} from "../../scripts/context-compiler.mjs";
import {
  DIFF_FORMATS,
  diffStates,
  renderDiffJson,
  renderDiffMarkdown,
  runDiff,
} from "../../scripts/context-diff.mjs";
import {
  findLinkProvenance,
  linkPathFor,
  linkProvenanceRecord,
  obsidianLink,
  obsidianStatus,
  obsidianUnlink,
  recordLinkProvenance,
  removeLinkProvenance,
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

export function assertNotEqual(actual, expected, msg) {
  if (actual === expected) {
    throw new Error(`${msg || "should differ"}: both sides are ${JSON.stringify(actual)}`);
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
      listDir: async (p) => {
        const prefix = p.endsWith("/") ? p : `${p}/`;
        const names = new Set();
        for (const key of store.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
        }
        return [...names];
      },
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

  test("migrate: a rename-phase failure rolls every replaced file back byte-identically", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const plan = planMigration(inputs);
    const seed = seedFromInputs(inputs);
    const io = makeFakeIo(seed);

    // Inject a failure on the SECOND temp->final rename (context-map.md has
    // already been moved into place; it had no original).
    const baseRename = io.rename;
    let finalRenames = 0;
    io.rename = async (from, to) => {
      if (from.endsWith(".migration-tmp")) {
        finalRenames += 1;
        if (finalRenames === 2) throw new Error("injected rename failure");
      }
      return baseRename(from, to);
    };

    await assertRejects(
      () =>
        applyMigration(
          plan,
          { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH },
          io,
          { timestamp: "2026-07-26T00:00:00.000Z" }
        ),
      "injected rename failure should abort the migration"
    );

    // Every original file is byte-identical afterwards.
    for (const [key, value] of Object.entries(seed)) {
      assertEqual(io.store.get(key), value, `original file changed despite rollback: ${key}`);
    }
    // The already-renamed new file (no original) is removed again.
    assert(!io.store.has(`${MIGRATE_HANDOFF_DIR}/context-map.md`), "rolled-back output left behind");
    // No temp or rollback residue remains.
    for (const key of io.store.keys()) {
      assert(!key.includes("migration-tmp"), `temp file left behind: ${key}`);
      assert(!key.includes("migration-rollback"), `rollback file left behind: ${key}`);
    }
  });

  test("migrate: a rollback-cleanup failure after commit must NOT roll back the migration", async () => {
    const inputs = await readHandoffInputs("legacy-1x");
    const plan = planMigration(inputs);
    const seed = seedFromInputs(inputs);
    const io = makeFakeIo(seed);

    // Inject a failure on the SECOND rollback-sibling remove. By then every
    // new file is renamed into place — the migration is committed — so this
    // failure must not trigger the transactional rollback.
    const baseRemove = io.remove;
    let rollbackRemoves = 0;
    io.remove = async (p) => {
      if (p.endsWith(".migration-rollback")) {
        rollbackRemoves += 1;
        if (rollbackRemoves === 2) throw new Error("injected cleanup failure");
      }
      return baseRemove(p);
    };

    const result = await applyMigration(
      plan,
      { handoffDir: MIGRATE_HANDOFF_DIR, configPath: MIGRATE_CONFIG_PATH },
      io,
      { timestamp: "2026-07-26T00:00:00.000Z" }
    );
    assert(result.migrated, "cleanup failure must not fail a committed migration");

    // Every new v2 output is in place with its planned content (nothing rolled back).
    for (const [name, content] of Object.entries(plan.outputs)) {
      const finalPath = name === ".handoff.config.json" ? MIGRATE_CONFIG_PATH : `${MIGRATE_HANDOFF_DIR}/${name}`;
      assertEqual(io.store.get(finalPath), content, `committed output missing or rolled back: ${name}`);
    }
    // No temp residue; leftover rollback siblings are tolerated but originals
    // must not reappear in place of the committed outputs (no mixed state).
    for (const key of io.store.keys()) {
      assert(!key.includes("migration-tmp"), `temp file left behind: ${key}`);
    }
    const json = JSON.parse(io.store.get(`${MIGRATE_HANDOFF_DIR}/context.json`));
    assertEqual(json.version, PROTOCOL_VERSION, "context.json was rolled back to legacy");
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

  // ── v3 canonical state (directory + content files) ─────────────────────────

  const V3_FIXTURE = "v3/basic/.handoff";
  const V3_DIR = "/v3proj/.handoff";
  const readV3 = (rel) => readFixture(`${V3_FIXTURE}/${rel}`);

  async function makeV3Io(overrides = {}) {
    const seed = {};
    seed[`${V3_DIR}/context-map.md`] = await readV3("context-map.md");
    for (const name of Object.values(CONTENT_FILES)) {
      seed[`${V3_DIR}/${CONTENT_DIR}/${name}`] = await readV3(`${CONTENT_DIR}/${name}`);
    }
    for (const [path, content] of Object.entries(overrides)) {
      if (content == null) delete seed[path];
      else seed[path] = content;
    }
    return makeFakeIo(seed);
  }

  async function loadError(io) {
    try {
      await loadHandoffState(io, V3_DIR);
    } catch (err) {
      return err;
    }
    return null;
  }

  test("v3 registry: eight content files and ID prefixes in deterministic section order", () => {
    assertEqual(
      JSON.stringify(Object.keys(CONTENT_FILES)),
      JSON.stringify(["goals", "status", "tasks", "decisions", "questions", "risks", "notes", "excluded"]),
      "CONTENT_FILES must cover the eight semantic sections in deterministic order"
    );
    assertEqual(JSON.stringify(Object.keys(ID_PREFIXES)), JSON.stringify(Object.keys(CONTENT_FILES)));
    assertEqual(CONTENT_FILES.goals, "current-goal.md");
    assertEqual(CONTENT_FILES.status, "current-status.md");
    assertEqual(CONTENT_FILES.tasks, "tasks.md");
    assertEqual(CONTENT_FILES.decisions, "decisions.md");
    assertEqual(CONTENT_FILES.questions, "open-questions.md");
    assertEqual(CONTENT_FILES.risks, "risks.md");
    assertEqual(CONTENT_FILES.notes, "knowledge-notes.md");
    assertEqual(CONTENT_FILES.excluded, "excluded.md");
    assertEqual(ID_PREFIXES.goals, "goal");
    assertEqual(ID_PREFIXES.notes, "note");
    assertEqual(JSON.stringify([...V3_SECTION_KEYS]), JSON.stringify(Object.keys(CONTENT_FILES)));
    assert(Object.isFrozen(CONTENT_FILES) && Object.isFrozen(ID_PREFIXES), "registries must be immutable");
    for (const key of V3_SECTION_KEYS) {
      assert(V3_SECTION_LABELS[key] && V3_SECTION_LABELS[key].en, `missing labels for '${key}'`);
      assertEqual(v3SectionKeyForLabel(V3_SECTION_LABELS[key].en), key, `label lookup broken for '${key}'`);
    }
    assertEqual(v3SectionKeyForLabel(V3_SECTION_LABELS.goals.zh), "goals", "localized label must resolve");
    assertEqual(v3SectionKeyForLabel(V3_SECTION_LABELS.notes.zh), "notes", "localized label must resolve");
  });

  test("v3 grammar: NODE_ID_RE accepts short prefixed IDs and rejects the rest", () => {
    for (const ok of ["goal1", "status2", "task10", "decision3", "question4", "risk5", "note6", "excluded7"]) {
      assert(NODE_ID_RE.test(ok), `'${ok}' must be a valid node ID`);
    }
    for (const bad of ["task0", "task01", "foo1", "TASK1", "task", "task-1", "1task", "task 1", "", "goal1x"]) {
      assert(!NODE_ID_RE.test(bad), `'${bad}' must be rejected`);
    }
  });

  test("v3 parse: directory exposes eight sections with stable IDs and no bodies", async () => {
    const map = parseContextMapV3(await readV3("context-map.md"));
    assert(map, "expected a parsed v3 map");
    assertEqual(
      JSON.stringify(Object.keys(map.sections)),
      JSON.stringify([...V3_SECTION_KEYS]),
      "sections must appear in deterministic order"
    );

    const task = map.sections.tasks[0];
    assertEqual(task.id, "task1");
    assertEqual(task.label, "Complete the v3 storage migration");
    assertEqual(task.checked, false);
    assertEqual(task.priority, "high");
    assertEqual(task.depth, 0);
    for (const field of ["text", "body", "summary"]) {
      assert(!(field in task), `directory node must not carry '${field}'`);
    }

    const child = map.sections.tasks[1];
    assertEqual(child.id, "task2");
    assertEqual(child.depth, 1, "hierarchy must survive the parse");
    assertEqual(child.checked, true);

    assertEqual(map.sections.goals[0].id, "goal1");
    assertEqual(map.sections.goals[0].label, "Ship the v3 context directory release");
    assertEqual(map.sections.status[0].id, "status1");
    assertEqual(map.sections.decisions[0].id, "decision1");
    assertEqual(map.sections.questions[0].id, "question1");
    assertEqual(map.sections.risks[0].id, "risk1");
    assertEqual(map.sections.risks[0].severity, "high", "risk severity must parse");
    assertEqual(map.sections.notes[0].id, "note1");
    assertEqual(map.sections.excluded[0].id, "excluded1");
  });

  test("v3 parse: an empty Current Goal section is valid", () => {
    const empty = emptyContextMapV3();
    empty.sections.tasks.push({ id: "task1", label: "Only task", origin: "user", depth: 0, checked: false });
    const map = parseContextMapV3(renderContextMapV3(empty));
    assert(map, "a map without goal nodes must still parse");
    assertEqual(map.sections.goals.length, 0, "empty Current Goal must stay empty");
    assertEqual(map.sections.tasks[0].id, "task1");
  });

  test("v3 render/parse: round-trip preserves IDs, labels, hierarchy, state, and metadata", async () => {
    const before = parseContextMapV3(await readV3("context-map.md"));
    for (const lang of ["en", "zh"]) {
      const after = parseContextMapV3(renderContextMapV3(before, { lang }));
      assertEqual(
        JSON.stringify(Object.keys(after.sections)),
        JSON.stringify([...V3_SECTION_KEYS]),
        `section order drifted (lang=${lang})`
      );
      for (const key of V3_SECTION_KEYS) {
        assertEqual(after.sections[key].length, before.sections[key].length, `node count drift in ${key} (lang=${lang})`);
        for (let i = 0; i < before.sections[key].length; i++) {
          const a = after.sections[key][i];
          const b = before.sections[key][i];
          for (const field of ["id", "label", "depth", "checked", "priority", "severity", "origin"]) {
            assertEqual(a[field], b[field], `${field} drift in ${key}[${i}] (lang=${lang})`);
          }
        }
      }
    }
    const rendered = renderContextMapV3(before);
    assertIncludes(rendered, "- [ ] `task1` **high** Complete the v3 storage migration");
    assertIncludes(rendered, "- `decision1` Context Map is the semantic directory");
    assertIncludes(rendered, "v3.0.0");
  });

  test("v3 render/parse: agent ownership markers round-trip and edits transfer ownership", () => {
    const map = emptyContextMapV3();
    map.sections.tasks.push({ id: "task9", label: "Agent inferred task", origin: "agent", depth: 0, checked: false });
    const rendered = renderContextMapV3(map);
    assertIncludes(rendered, AGENT_MARKER, "agent node must carry the ownership marker");

    const parsed = parseContextMapV3(rendered);
    assertEqual(parsed.sections.tasks[0].origin, "agent", "fresh agent node must stay agent-owned");

    const edited = rendered.replace("Agent inferred task", "User refined task");
    const reparsed = parseContextMapV3(edited);
    assertEqual(reparsed.sections.tasks[0].origin, "user", "editing the label must transfer ownership");
    assertEqual(reparsed.sections.tasks[0].id, "task9", "ownership transfer must keep the ID");
  });

  test("v3 content: entries are addressed by stable node ID with summary/body split", async () => {
    const entries = parseContentFile(await readV3(`${CONTENT_DIR}/tasks.md`), "tasks");
    assertEqual(entries.length, 2, "expected two task entries");
    assertEqual(entries[0].id, "task1");
    assertEqual(
      entries[0].summary,
      "Split embedded v2 Context Map semantics into section body files without losing hierarchy or text."
    );
    assertIncludes(entries[0].body, "temporary siblings");
    assertEqual(entries[1].id, "task2");
    assertEqual(entries[1].summary, "Use short, stable, monotonically increasing IDs for node addressing.");
    assertEqual(entries[1].body, "", "single-paragraph entry has summary only");
    for (const entry of entries) {
      assert(!("label" in entry), "content entries must not duplicate the node label");
    }
  });

  test("v3 content: render/parse round-trip preserves every entry verbatim", async () => {
    for (const key of V3_SECTION_KEYS) {
      const entries = parseContentFile(await readV3(`${CONTENT_DIR}/${CONTENT_FILES[key]}`), key);
      const rendered = renderContentFile(key, entries);
      const reparsed = parseContentFile(rendered, key);
      assertEqual(reparsed.length, entries.length, `entry count drift in ${key}`);
      for (let i = 0; i < entries.length; i++) {
        for (const field of ["id", "summary", "body", "origin"]) {
          assertEqual(reparsed[i][field], entries[i][field], `${field} drift in ${key}[${i}]`);
        }
      }
      assertIncludes(rendered, `## ${entries[0].id}`, `entry heading missing in ${key}`);
    }
  });

  test("v3 content: agent body markers round-trip and body edits transfer ownership", () => {
    const entries = [{ id: "note3", summary: "Agent summary.", body: "Agent detail.", origin: "agent" }];
    const rendered = renderContentFile("notes", entries);
    assertIncludes(rendered, AGENT_MARKER);
    const parsed = parseContentFile(rendered, "notes");
    assertEqual(parsed[0].origin, "agent");

    const edited = rendered.replace("Agent detail.", "User edited detail.");
    const reparsed = parseContentFile(edited, "notes");
    assertEqual(reparsed[0].origin, "user", "editing the body must transfer ownership");
    assertEqual(reparsed[0].summary, "Agent summary.", "summary must survive a body edit");
  });

  test("v3 state: loadHandoffState joins the directory and content by stable ID", async () => {
    const io = await makeV3Io();
    const state = await loadHandoffState(io, V3_DIR);
    assertEqual(state.version, V3_PROTOCOL_VERSION);
    assertEqual(state.diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(state.diagnostics)}`);
    assertEqual(state.map.sections.tasks[0].id, "task1");
    assertEqual(state.content.tasks[0].id, "task1");
    assertIncludes(state.content.tasks[0].body, "temporary siblings");
    assertEqual(state.content.goals[0].summary, "Release Handoff Protocol v3.0.0 with the Context Map as a semantic directory.");
    for (const key of V3_SECTION_KEYS) {
      assert(Array.isArray(state.content[key]), `missing content bucket '${key}'`);
    }
  });

  test("v3 state: indexContextMap resolves every Map ID to its section", async () => {
    const map = parseContextMapV3(await readV3("context-map.md"));
    const index = indexContextMap(map);
    assertEqual(index.duplicates.length, 0, "fixture must not contain duplicate IDs");
    assertEqual(index.invalid.length, 0, "fixture must not contain invalid IDs");
    assertEqual(index.byId.get("task1").sectionKey, "tasks");
    assertEqual(index.byId.get("task2").sectionKey, "tasks");
    assertEqual(index.byId.get("goal1").sectionKey, "goals");
    assertEqual(index.byId.get("note1").sectionKey, "notes");
  });

  test("v3 state: missing required content files fail with an actionable diagnostic", async () => {
    const io = await makeV3Io({ [`${V3_DIR}/${CONTENT_DIR}/risks.md`]: null });
    const err = await loadError(io);
    assert(err, "a missing content file must fail the load");
    assertIncludes(err.message, "risks.md", "error must name the missing file");
    assert(/missing/i.test(err.message), "error must call the file missing");
  });

  test("v3 state: duplicate IDs in the directory fail with an actionable diagnostic", async () => {
    const dup = (await readV3("context-map.md")).replace(
      "- `excluded1` No vector database in v3",
      "- `excluded1` No vector database in v3\n- `task1` Duplicate ID reference"
    );
    const err = await loadError(await makeV3Io({ [`${V3_DIR}/context-map.md`]: dup }));
    assert(err, "duplicate Map IDs must fail the load");
    assertIncludes(err.message, "task1");
    assert(/duplicate/i.test(err.message));
  });

  test("v3 state: unknown and malformed node IDs fail with an actionable diagnostic", async () => {
    for (const badId of ["foo9", "task0"]) {
      const broken = (await readV3("context-map.md")).replace("`task1`", `\`${badId}\``);
      const err = await loadError(await makeV3Io({ [`${V3_DIR}/context-map.md`]: broken }));
      assert(err, `invalid ID '${badId}' must fail the load`);
      assertIncludes(err.message, badId, `error must name '${badId}'`);
      assert(/ID_INVALID|invalid/i.test(err.message), `error must flag the ID as invalid: ${err.message}`);
    }
  });

  test("v3 state: cross-section ID prefixes fail with an actionable diagnostic", async () => {
    // A risk-prefixed entry inside the tasks content file with no matching Map move.
    const misplaced = "# Tasks\n\n## risk1\n\nMisplaced body.\n";
    const err = await loadError(await makeV3Io({ [`${V3_DIR}/${CONTENT_DIR}/tasks.md`]: misplaced }));
    assert(err, "a cross-section body prefix must fail the load");
    assertIncludes(err.message, "risk1");
    assert(/CONTENT_MISPLACED|misplaced|section/i.test(err.message), `error must explain the mismatch: ${err.message}`);
  });

  test("v3 state: the same ID in two content files fails as CONTENT_DUPLICATE", async () => {
    const dup = (await readV3(`${CONTENT_DIR}/decisions.md`)) + "\n## task1\n\nDuplicate body.\n";
    const err = await loadError(await makeV3Io({ [`${V3_DIR}/${CONTENT_DIR}/decisions.md`]: dup }));
    assert(err, "an ID in two body files must fail the load");
    assertIncludes(err.message, "task1");
    assertIncludes(err.message, "CONTENT_DUPLICATE");
  });

  test("v3 state: missing bodies and orphan content are diagnostics, not failures", async () => {
    // Map references task3 with no body; content gains an unreferenced entry.
    const withRef = (await readV3("context-map.md")).replace(
      "  - [x] `task2` Define node addressing",
      "  - [x] `task2` Define node addressing\n- [ ] `task3` Document the layout"
    );
    const orphanNotes = (await readV3(`${CONTENT_DIR}/knowledge-notes.md`)) + "\n## note9\n\nOrphaned note body.\n";
    const io = await makeV3Io({
      [`${V3_DIR}/context-map.md`]: withRef,
      [`${V3_DIR}/${CONTENT_DIR}/knowledge-notes.md`]: orphanNotes,
    });
    const state = await loadHandoffState(io, V3_DIR);
    const diag = state.diagnostics.join("\n");
    assertIncludes(diag, "CONTENT_MISSING", "missing body must be diagnosed");
    assertIncludes(diag, "task3");
    assertIncludes(diag, "CONTENT_ORPHAN", "orphan body must be diagnosed");
    assertIncludes(diag, "note9");
    assertEqual(state.content.notes.at(-1).id, "note9", "orphan content must be retained, not deleted");
  });

  test("v3 state: a non-empty body without a first-paragraph summary is diagnosed", async () => {
    const noSummary = "# Risks\n\n## risk1\n\n### Details first\n\nA body with no summary paragraph.\n";
    const io = await makeV3Io({ [`${V3_DIR}/${CONTENT_DIR}/risks.md`]: noSummary });
    const state = await loadHandoffState(io, V3_DIR);
    const diag = state.diagnostics.join("\n");
    assertIncludes(diag, "CONTENT_SUMMARY_MISSING");
    assertIncludes(diag, "risk1");
    const entry = state.content.risks[0];
    assertEqual(entry.summary, "");
    assertIncludes(entry.body, "Details first");
  });

  test("v3 state: a node moved across sections keeps its ID and resolves its body", async () => {
    // task1 moves to Knowledge and Notes; its body moves to knowledge-notes.md,
    // still keyed `task1`. The historical prefix no longer matches the section.
    const moved = (await readV3("context-map.md")).replace(
      "- [ ] `task1` **high** Complete the v3 storage migration\n",
      ""
    ).replace(
      "- `note1` Deno and Node share one canonical state loader",
      "- `task1` Complete the v3 storage migration\n- `note1` Deno and Node share one canonical state loader"
    );
    const movedBody = (await readV3(`${CONTENT_DIR}/tasks.md`)).replace(
      /## task1\n[\s\S]*?(?=## task2)/,
      ""
    );
    const notesBody = (await readV3(`${CONTENT_DIR}/knowledge-notes.md`)) +
      "\n## task1\n\nSplit embedded v2 Context Map semantics into section body files without losing hierarchy or text.\n\nMigration builds the complete v3 state in temporary siblings, verifies every reference, and installs it atomically.\n";
    const io = await makeV3Io({
      [`${V3_DIR}/context-map.md`]: moved,
      [`${V3_DIR}/${CONTENT_DIR}/tasks.md`]: movedBody,
      [`${V3_DIR}/${CONTENT_DIR}/knowledge-notes.md`]: notesBody,
    });
    const state = await loadHandoffState(io, V3_DIR);
    assertEqual(state.diagnostics.length, 0, `a legal move must not be diagnosed: ${JSON.stringify(state.diagnostics)}`);
    assertEqual(state.map.sections.notes[0].id, "task1", "moved node must keep its ID");
    assertEqual(state.map.sections.notes[0].checked, undefined, "a non-task section node carries no checkbox");
    assertIncludes(state.content.notes.at(-1).body, "temporary siblings");
  });

  test("v3 state: validateHandoffState reports soft issues without throwing", async () => {
    const io = await makeV3Io();
    const state = await loadHandoffState(io, V3_DIR);
    assertEqual(JSON.stringify(validateHandoffState(state)), JSON.stringify([]), "clean fixture must validate clean");
    state.content.excluded.push({ id: "excluded9", summary: "Orphan.", body: "", origin: "user" });
    const diag = validateHandoffState(state).join("\n");
    assertIncludes(diag, "CONTENT_ORPHAN");
    assertIncludes(diag, "excluded9");
  });

  // ── v3 stable IDs and ownership-aware reconciliation ───────────────────────

  function makeV3State({ sections = {}, content = {} } = {}) {
    const map = emptyContextMapV3();
    for (const [key, nodes] of Object.entries(sections)) map.sections[key] = nodes;
    const bodies = emptyV3Content();
    for (const [key, entries] of Object.entries(content)) bodies[key] = entries;
    return { version: V3_PROTOCOL_VERSION, map, content: bodies, diagnostics: [] };
  }

  test("v3 ids: allocation starts at 1 per section prefix and never fills holes", () => {
    const counters = {};
    assertEqual(allocateNodeId("tasks", counters), "task1");
    assertEqual(allocateNodeId("tasks", counters), "task2");
    assertEqual(allocateNodeId("goals", counters), "goal1");
    assertEqual(allocateNodeId("status", counters), "status1");
    assertEqual(allocateNodeId("decisions", counters), "decision1");
    assertEqual(allocateNodeId("questions", counters), "question1");
    assertEqual(allocateNodeId("risks", counters), "risk1");
    assertEqual(allocateNodeId("notes", counters), "note1");
    assertEqual(allocateNodeId("excluded", counters), "excluded1");
    // Holes are never filled and counters never decrement.
    const holed = { task: 5 };
    assertEqual(allocateNodeId("tasks", holed), "task6");
    let threw = false;
    try {
      allocateNodeId("bogus", {});
    } catch (err) {
      threw = true;
      assertIncludes(err.message, "bogus");
    }
    assert(threw, "unknown section must be rejected");
  });

  test("v3 ids: counters recover from live nodes, bodies, and historical metadata", async () => {
    const state = await loadHandoffState(await makeV3Io(), V3_DIR);

    const missing = recoverIdCounters(state, null);
    assertEqual(missing.counters.goal, 1);
    assertEqual(missing.counters.status, 1);
    assertEqual(missing.counters.task, 2);
    assertEqual(missing.counters.decision, 1);
    assertEqual(missing.counters.question, 1);
    assertEqual(missing.counters.risk, 1);
    assertEqual(missing.counters.note, 1);
    assertEqual(missing.counters.excluded, 1);
    assert(missing.recovered, "missing metadata counters must be reconstructed");

    const healthy = recoverIdCounters(state, { idCounters: { task: 7, goal: 1 } });
    assertEqual(healthy.counters.task, 7, "stored counters win when they exceed live state");
    assertEqual(healthy.counters.goal, 1);
    assert(!healthy.recovered, "valid metadata counters are not a recovery");

    const ahead = recoverIdCounters(state, { idCounters: { task: 1 } });
    assertEqual(ahead.counters.task, 2, "live nodes raise a stale counter");
    assert(!ahead.recovered);

    const damaged = recoverIdCounters(state, { idCounters: "garbage" });
    assertEqual(damaged.counters.task, 2, "damaged metadata falls back to live state");
    assert(damaged.recovered, "damaged metadata counters must be flagged as recovered");
  });

  test("v3 reconcile: renamed and moved nodes keep their IDs", () => {
    const existing = makeV3State({
      sections: {
        tasks: [{ id: "task1", label: "Renamed by the user", origin: "user", depth: 0, checked: false }],
        notes: [{ id: "task2", label: "Moved into notes", origin: "user", depth: 0 }],
      },
      content: {
        tasks: [{ id: "task1", summary: "Original summary.", body: "Original body.", origin: "user" }],
        notes: [{ id: "task2", summary: "Moved summary.", body: "", origin: "user" }],
      },
    });
    const result = reconcileV3State({ existing, inferred: {} });
    assertEqual(result.map.sections.tasks.length, 1);
    assertEqual(result.map.sections.tasks[0].id, "task1", "a rename must keep the ID");
    assertEqual(result.map.sections.tasks[0].label, "Renamed by the user");
    assertEqual(result.map.sections.notes[0].id, "task2", "a move must keep the ID");
    assertEqual(result.content.tasks[0].summary, "Original summary.", "user body must be untouched");
    assertEqual(result.content.notes[0].id, "task2", "the body follows its node to the new section");
    assertEqual(
      result.content.tasks.filter((e) => e.id === "task2").length,
      0,
      "a moved body must not linger in the old section"
    );
  });

  test("v3 reconcile: a task state flip changes only the directory", () => {
    const existing = makeV3State({
      sections: {
        tasks: [{ id: "task1", label: "Wire the migration", origin: "agent", depth: 0, checked: false }],
      },
      content: {
        tasks: [{ id: "task1", summary: "Keep this summary.", body: "Keep this body.", origin: "agent" }],
      },
    });
    const result = reconcileV3State({
      existing,
      inferred: { tasks: [{ label: "Wire the migration", checked: true }] },
    });
    assertEqual(result.map.sections.tasks.length, 1, "state flip must not duplicate the node");
    assertEqual(result.map.sections.tasks[0].id, "task1");
    assertEqual(result.map.sections.tasks[0].checked, true);
    assertEqual(result.content.tasks[0].summary, "Keep this summary.", "content must be untouched");
    assertEqual(result.content.tasks[0].body, "Keep this body.", "content must be untouched");
  });

  test("v3 reconcile: a summary/body update changes only the content entry", () => {
    const existing = makeV3State({
      sections: {
        notes: [{ id: "note1", label: "Shared loader", origin: "agent", depth: 0 }],
      },
      content: {
        notes: [{ id: "note1", summary: "Old summary.", body: "Old body.", origin: "agent" }],
      },
    });
    const result = reconcileV3State({
      existing,
      inferred: { notes: [{ label: "Shared loader", summary: "New summary.", body: "New body." }] },
    });
    const node = result.map.sections.notes[0];
    assertEqual(node.id, "note1");
    assertEqual(node.label, "Shared loader");
    assertEqual(node.depth, 0);
    assertEqual(result.content.notes[0].summary, "New summary.");
    assertEqual(result.content.notes[0].body, "New body.");
  });

  test("v3 reconcile: a user-edited label wins over an inferred replacement", () => {
    const existing = makeV3State({
      sections: {
        tasks: [{ id: "task1", label: "User refined label", origin: "user", depth: 0, checked: false }],
      },
      content: {
        tasks: [{ id: "task1", summary: "User summary.", body: "", origin: "user" }],
      },
    });
    const result = reconcileV3State({
      existing,
      inferred: { tasks: [{ label: "Agent replacement", summary: "Agent summary." }] },
    });
    assertEqual(result.map.sections.tasks.length, 2, "the inference is appended, never a takeover");
    assertEqual(result.map.sections.tasks[0].id, "task1");
    assertEqual(result.map.sections.tasks[0].label, "User refined label");
    assertEqual(result.map.sections.tasks[1].origin, "agent");
    assertEqual(result.map.sections.tasks[1].label, "Agent replacement");
    assertNotEqual(
      result.map.sections.tasks[1].id,
      "task1",
      "the appended inference must allocate a fresh ID"
    );
    assertEqual(result.content.tasks[0].summary, "User summary.", "user body must win");
  });

  test("v3 reconcile: id-targeted inference against a user-owned node is rejected", () => {
    const existing = makeV3State({
      sections: {
        decisions: [{ id: "decision1", label: "User decision", origin: "user", depth: 0 }],
      },
      content: {
        decisions: [{ id: "decision1", summary: "User rationale.", body: "", origin: "user" }],
      },
    });
    const result = reconcileV3State({
      existing,
      inferred: { decisions: [{ id: "decision1", label: "Agent override", summary: "Agent rationale." }] },
    });
    assertEqual(result.map.sections.decisions.length, 1);
    assertEqual(result.map.sections.decisions[0].label, "User decision");
    assertEqual(result.content.decisions[0].summary, "User rationale.");
    const diag = result.diagnostics.join("\n");
    assertIncludes(diag, "INFERENCE_REJECTED");
    assertIncludes(diag, "decision1");
  });

  test("v3 reconcile: a deleted node is not recreated from its leftover body", () => {
    const existing = makeV3State({
      sections: { tasks: [] },
      content: { tasks: [{ id: "task5", summary: "Leftover body.", body: "", origin: "agent" }] },
    });
    const result = reconcileV3State({ existing, inferred: {} });
    assertEqual(result.map.sections.tasks.length, 0, "the deleted node must stay deleted");
    assertEqual(result.content.tasks.length, 1, "the orphan body is retained, never auto-deleted");
    assertEqual(result.content.tasks[0].id, "task5");
    const diag = result.diagnostics.join("\n");
    assertIncludes(diag, "CONTENT_ORPHAN");
    assertIncludes(diag, "task5");
  });

  test("v3 reconcile: deleted IDs are never reused for new nodes", () => {
    const existing = makeV3State({
      sections: {
        tasks: [{ id: "task1", label: "Survivor", origin: "user", depth: 0, checked: false }],
      },
      content: { tasks: [{ id: "task1", summary: "S.", body: "", origin: "user" }] },
    });
    const result = reconcileV3State({
      existing,
      inferred: { tasks: [{ label: "Brand new task" }] },
      metadata: { idCounters: { task: 3 } },
    });
    const appended = result.map.sections.tasks.at(-1);
    assertEqual(appended.label, "Brand new task");
    assertEqual(appended.id, "task4", "allocation must continue past the historical high-water mark");
    assertEqual(result.counters.task, 4);
  });

  test("v3 reconcile: empty Current Goal stays empty without an explicit user goal", () => {
    const inferred = {
      goals: [{ label: "release: prepare 3.0.0" }],
      status: [{ label: "in-progress" }],
    };
    const result = reconcileV3State({ existing: null, inferred });
    assertEqual(result.map.sections.goals.length, 0, "inference must never invent a goal");
    const diag = result.diagnostics.join("\n");
    assertIncludes(diag, "INFERENCE_REJECTED", "the rejected goal inference must be reported");

    const explicit = reconcileV3State({ existing: null, inferred: {}, userIntent: { goal: "Ship v3" } });
    assertEqual(explicit.map.sections.goals.length, 1);
    assertEqual(explicit.map.sections.goals[0].id, "goal1");
    assertEqual(explicit.map.sections.goals[0].label, "Ship v3");
    assertEqual(explicit.map.sections.goals[0].origin, "user", "an explicit goal is user-owned");

    const updated = reconcileV3State({
      existing: explicit,
      inferred: { goals: [{ label: "commit-derived goal" }] },
      userIntent: { goal: "Ship v3.0.0 instead" },
    });
    assertEqual(updated.map.sections.goals.length, 1, "singleton goal must not duplicate");
    assertEqual(updated.map.sections.goals[0].id, "goal1", "an explicit goal update keeps the ID");
    assertEqual(updated.map.sections.goals[0].label, "Ship v3.0.0 instead");
  });

  test("v3 reconcile: user-owned status suppresses inference like v2 singletons", () => {
    const existing = makeV3State({
      sections: { status: [{ id: "status1", label: "User status", origin: "user", depth: 0 }] },
      content: { status: [{ id: "status1", summary: "User status body.", body: "", origin: "user" }] },
    });
    const result = reconcileV3State({
      existing,
      inferred: { status: [{ label: "in-progress - 3 file(s) modified" }] },
    });
    assertEqual(result.map.sections.status.length, 1);
    assertEqual(result.map.sections.status[0].label, "User status");

    const agentExisting = makeV3State({
      sections: { status: [{ id: "status1", label: "old status", origin: "agent", depth: 0 }] },
      content: { status: [{ id: "status1", summary: "old", body: "", origin: "agent" }] },
    });
    const updated = reconcileV3State({
      existing: agentExisting,
      inferred: { status: [{ label: "in-progress - 3 file(s) modified" }] },
    });
    assertEqual(updated.map.sections.status.length, 1, "agent status is updated in place");
    assertEqual(updated.map.sections.status[0].id, "status1", "status update keeps the ID");
    assertEqual(updated.map.sections.status[0].label, "in-progress - 3 file(s) modified");
  });

  test("v3 reconcile: semantic duplicates are not appended", () => {
    const existing = makeV3State({
      sections: { excluded: [{ id: "excluded1", label: "No vector database in v3", origin: "user", depth: 0 }] },
      content: { excluded: [{ id: "excluded1", summary: "S.", body: "", origin: "user" }] },
    });
    const result = reconcileV3State({
      existing,
      inferred: { excluded: [{ label: "**high** No vector database in v3." }] },
    });
    assertEqual(result.map.sections.excluded.length, 1, "a semantic duplicate must not be appended");
  });

  test("v3 reconcile: user-owned bodies are never overwritten by inference", () => {
    const existing = makeV3State({
      sections: {
        tasks: [{ id: "task1", label: "Stable task", origin: "user", depth: 0, checked: false }],
      },
      content: { tasks: [{ id: "task1", summary: "User body.", body: "User detail.", origin: "user" }] },
    });
    const result = reconcileV3State({
      existing,
      inferred: { tasks: [{ label: "Stable task", summary: "Agent rewrite.", body: "Agent detail." }] },
    });
    assertEqual(result.map.sections.tasks.length, 1);
    assertEqual(result.content.tasks[0].summary, "User body.");
    assertEqual(result.content.tasks[0].body, "User detail.");
    assertIncludes(result.diagnostics.join("\n"), "INFERENCE_REJECTED");
  });

  test("v3 reconcile: output renders and reparses through the production parsers", () => {
    const existing = makeV3State({
      sections: {
        tasks: [
          { id: "task1", label: "Parent", origin: "user", depth: 0, checked: false, priority: "high" },
          { id: "task2", label: "Child", origin: "agent", depth: 1, checked: true },
        ],
        risks: [{ id: "risk1", label: "Risky", origin: "agent", depth: 0, severity: "high" }],
      },
      content: {
        tasks: [
          { id: "task1", summary: "Parent summary.", body: "Parent body.", origin: "user" },
          { id: "task2", summary: "Child summary.", body: "", origin: "agent" },
        ],
        risks: [{ id: "risk1", summary: "Risk summary.", body: "", origin: "agent" }],
      },
    });
    const result = reconcileV3State({
      existing,
      inferred: { tasks: [{ label: "Fresh task", summary: "Fresh summary." }] },
    });
    const reparsed = parseContextMapV3(renderContextMapV3(result.map));
    for (const key of V3_SECTION_KEYS) {
      assertEqual(reparsed.sections[key].length, result.map.sections[key].length, `drift in ${key}`);
    }
    for (const key of V3_SECTION_KEYS) {
      const rendered = renderContentFile(key, result.content[key]);
      const entries = parseContentFile(rendered, key);
      assertEqual(entries.length, result.content[key].length, `content drift in ${key}`);
    }
    const fresh = result.map.sections.tasks.at(-1);
    assertEqual(fresh.id, "task3", "the new task continues the sequence");
    assertEqual(fresh.origin, "agent");
    assertEqual(result.counters.task, 3);
  });

  // ── v3 views, metadata, and initial layout ─────────────────────────────────

  const V3_META = {
    timestamp: "2026-08-02T00:00:00.000Z",
    agent: "test-agent",
    project: "fixture-app",
    lang: "en",
    git: { branch: "feature/v3", latest_commit: "abc1234", commit_message: "feat: v3", is_dirty: false },
  };

  test("v3 init: the initial layout holds the Map, eight content files, the view, and metadata", () => {
    const files = buildInitialV3Files({ project: "demo", timestamp: V3_META.timestamp, agent: "test", lang: "en" });
    const names = Object.keys(files).sort();

    assert(names.includes("context-map.md"), "Context Map missing from the initial layout");
    for (const name of Object.values(CONTENT_FILES)) {
      assert(names.includes(`${CONTENT_DIR}/${name}`), `content/${name} missing from the initial layout`);
    }
    assert(names.includes(`${"views"}/HANDOFF.md`), "views/HANDOFF.md missing from the initial layout");
    assert(names.includes("context.json"), "context.json missing from the initial layout");

    // No legacy root-level views in a fresh v3 directory.
    for (const legacy of ["HANDOFF.md", "tasks.md", "decisions.md"]) {
      assert(!names.includes(legacy), `legacy root file '${legacy}' must not be created in v3`);
    }

    // The initial Map parses, has all eight sections, and an empty Current Goal.
    const map = parseContextMapV3(files["context-map.md"]);
    assert(map, "initial Context Map must parse");
    assertEqual(map.sections.goals.length, 0, "initial Current Goal must be empty");
    for (const key of V3_SECTION_KEYS) {
      assertEqual(map.sections[key].length, 0, `initial section '${key}' must be empty`);
      const entries = parseContentFile(files[`${CONTENT_DIR}/${CONTENT_FILES[key]}`], key);
      assertEqual(entries.length, 0, `initial content file for '${key}' must have no entries`);
    }

    const json = JSON.parse(files["context.json"]);
    assertEqual(json.protocolVersion, "3.0.0");
    assert(json.idCounters && typeof json.idCounters === "object", "initial counters missing");
    for (const prefix of Object.values(ID_PREFIXES)) {
      assertEqual(json.idCounters[prefix], 0, `initial counter for '${prefix}' must be 0`);
    }
  });

  test("v3 views: HANDOFF.md is deterministic and carries a prominent do-not-edit notice", async () => {
    const state = await loadHandoffState(await makeV3Io(), V3_DIR);
    const first = generateV3Views(state, V3_META);
    const second = generateV3Views(state, V3_META);

    assertEqual(JSON.stringify(Object.keys(first)), JSON.stringify(["views/HANDOFF.md"]));
    const handoff = first["views/HANDOFF.md"];
    assertEqual(second["views/HANDOFF.md"], handoff, "v3 view generation is not deterministic");
    assert(handoff.startsWith(V3_GENERATED_MARKER), "view must start with the generated marker");
    assert(/do not edit/i.test(handoff), "view must carry a do-not-edit notice");
    assert(/context-map\.md/.test(handoff) && /content\//.test(handoff), "notice must point at the Map and content files");

    // Every node appears with label, summary, and body in stable section order.
    const tasksAt = handoff.indexOf("## Tasks");
    const decisionsAt = handoff.indexOf("## Decisions");
    assert(tasksAt > -1 && decisionsAt > tasksAt, "sections must follow the canonical order");
    assertIncludes(handoff, "task1");
    assertIncludes(handoff, "Complete the v3 storage migration");
    assertIncludes(handoff, "Split embedded v2 Context Map semantics into section body files without losing hierarchy or text.");
    assertIncludes(handoff, "temporary siblings");
    assertIncludes(handoff, "decision1");
    assertIncludes(handoff, "Context Map is the semantic directory");
    assertIncludes(handoff, "**Branch**: feature/v3");
  });

  test("v3 views: an empty Current Goal renders a documented placeholder", () => {
    const files = buildInitialV3Files({ project: "demo", timestamp: V3_META.timestamp, agent: "test", lang: "en" });
    assertIncludes(files["views/HANDOFF.md"], "No explicit goal set.");
  });

  test("v3 metadata: context.json carries the protocol version, counters, and every file hash", async () => {
    const state = await loadHandoffState(await makeV3Io(), V3_DIR);
    const json = buildV3ContextJson({
      state,
      project: V3_META.project,
      git: V3_META.git,
      environment: { timestamp: V3_META.timestamp, agent: V3_META.agent, lang: "en" },
      diagnostics: {},
    });

    assertEqual(json.protocolVersion, "3.0.0");
    assertEqual(json.timestamp, V3_META.timestamp);
    assertEqual(json.agent, "test-agent");
    assertEqual(json.project, "fixture-app");
    assertEqual(json.git.branch, "feature/v3");

    // Monotonic ID counters recovered from the canonical state.
    assertEqual(json.idCounters.task, 2);
    assertEqual(json.idCounters.goal, 1);
    assertEqual(json.idCounters.note, 1);

    // Hashes cover the Map, every content file, and the generated view.
    const expectedFiles = ["context-map.md", ...Object.values(CONTENT_FILES).map((n) => `${CONTENT_DIR}/${n}`), "views/HANDOFF.md"];
    assertEqual(JSON.stringify(Object.keys(json.hashes).sort()), JSON.stringify(expectedFiles.sort()));
    assertEqual(json.hashes["context-map.md"], sha256Hex(renderContextMapV3(state.map, { lang: "en" })));
    assertEqual(
      json.hashes[`${CONTENT_DIR}/tasks.md`],
      sha256Hex(renderContentFile("tasks", state.content.tasks))
    );
    assertEqual(json.hashes["views/HANDOFF.md"], sha256Hex(generateV3Views(state, V3_META)["views/HANDOFF.md"]));

    // No semantic fields leak into metadata.
    for (const field of ["current_goal", "status", "todos", "decisions", "risks", "notes", "goal"]) {
      assert(!(field in json), `semantic field '${field}' must not appear in v3 context.json`);
    }
  });

  // ── Semantic snapshots (v2.3) ─────────────────────────────────────────────

  const SNAP_HANDOFF_DIR = "/proj/.handoff";
  const SNAP_PATHS = { handoffDir: SNAP_HANDOFF_DIR };

  function sampleSnapshotMap(goalText = "Ship semantic snapshots") {
    const map = emptyContextMap();
    map.sections.goal.push({ text: goalText, origin: "agent", depth: 0 });
    map.sections.tasks.push({ text: "**high** Wire snapshot writes", origin: "agent", depth: 0, checked: false });
    map.sections.tasks.push({ text: "Review retention policy", origin: "user", depth: 1, checked: true });
    return map;
  }

  function snapshotFiles(io) {
    return [...io.store.keys()].filter((k) => k.includes(`${SNAPSHOT_DIR}/`)).sort();
  }

  test("snapshots: first save writes a normalized, sanitized snapshot", async () => {
    const io = makeFakeIo({});
    const result = await writeSnapshot(sampleSnapshotMap(), SNAP_PATHS, io, {
      timestamp: "2026-07-28T00:00:00.000Z",
    });
    assert(result.written, "first save should write a snapshot");

    const expected = `${SNAP_HANDOFF_DIR}/${SNAPSHOT_DIR}/2026-07-28T00-00-00-000Z-${result.digest}.json`;
    assertEqual(result.path, expected, "unexpected snapshot path");
    const raw = io.store.get(expected);
    assert(raw, "snapshot file missing");

    const parsed = JSON.parse(raw);
    assertEqual(parsed.version, PROTOCOL_VERSION);
    assertEqual(parsed.captured_at, "2026-07-28T00:00:00.000Z");
    assertEqual(parsed.digest, result.digest);
    assertEqual(parsed.digest, snapshotDigest(parsed.state), "stored digest does not cover the state");
    // Normalized: fixed section keys, never localized headings.
    assertEqual(JSON.stringify(Object.keys(parsed.state.sections)), JSON.stringify(SECTION_KEYS));
    assertEqual(parsed.state.sections.goal[0].text, "Ship semantic snapshots");
    assertEqual(parsed.state.sections.tasks[1].checked, true);
    assertEqual(parsed.state.sections.tasks[1].depth, 1);
    assertNotIncludes(raw, "agent-hash", "generated fingerprint leaked into the snapshot");
  });

  test("snapshots: unchanged save writes no new snapshot", async () => {
    const io = makeFakeIo({});
    const first = await writeSnapshot(sampleSnapshotMap(), SNAP_PATHS, io, {
      timestamp: "2026-07-28T00:00:00.000Z",
    });
    assert(first.written, "first save should write");
    const before = JSON.stringify([...io.store.entries()].sort());

    const second = await writeSnapshot(sampleSnapshotMap(), SNAP_PATHS, io, {
      timestamp: "2026-07-28T01:00:00.000Z",
    });
    assert(!second.written, "unchanged semantic state must not write a snapshot");
    assertEqual(second.reason, "unchanged");
    assertEqual(JSON.stringify([...io.store.entries()].sort()), before, "unchanged save touched files");
  });

  test("snapshots: changed save writes a new snapshot", async () => {
    const io = makeFakeIo({});
    await writeSnapshot(sampleSnapshotMap(), SNAP_PATHS, io, { timestamp: "2026-07-28T00:00:00.000Z" });

    const second = await writeSnapshot(sampleSnapshotMap("Ship semantic snapshots v2"), SNAP_PATHS, io, {
      timestamp: "2026-07-28T01:00:00.000Z",
    });
    assert(second.written, "changed semantic state must write a snapshot");
    assertEqual(snapshotFiles(io).length, 2, "changed save should leave both snapshots");
  });

  test("snapshots: retention keeps the latest 20 snapshots", async () => {
    const io = makeFakeIo({});
    for (let i = 0; i < SNAPSHOT_RETENTION + 3; i++) {
      await writeSnapshot(sampleSnapshotMap(`Goal revision ${i}`), SNAP_PATHS, io, {
        timestamp: `2026-07-28T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const files = snapshotFiles(io);
    assertEqual(files.length, SNAPSHOT_RETENTION, "retention should cap snapshots at the default 20");
    assert(files.some((f) => f.includes("00-00-22")), "newest snapshot was pruned");
    assert(!files.some((f) => f.includes("00-00-00")), "oldest snapshot was retained");
    assert(!files.some((f) => f.includes("00-00-02")), "third-oldest snapshot was retained");
  });

  test("snapshots: normalization is stable across localized headings and agent fingerprints", async () => {
    const en = parseContextMap(renderContextMap(sampleSnapshotMap(), { lang: "en" }));
    const zh = parseContextMap(renderContextMap(sampleSnapshotMap(), { lang: "zh" }));
    assertEqual(
      snapshotDigest(buildSnapshot(en)),
      snapshotDigest(buildSnapshot(zh)),
      "localized headings or regenerated fingerprints changed the semantic digest"
    );
  });

  test("snapshots: sensitive data is filtered before persistence", async () => {
    const map = sampleSnapshotMap();
    map.sections.knowledge.push({ text: "deploy key: api_key=abcdefghijklmnop123456", origin: "user", depth: 0 });
    const io = makeFakeIo({});
    const result = await writeSnapshot(map, SNAP_PATHS, io, { timestamp: "2026-07-28T00:00:00.000Z" });
    const raw = io.store.get(result.path);
    assertNotIncludes(raw, "abcdefghijklmnop123456", "secret leaked into the snapshot");
    assertIncludes(raw, "[REDACTED]");
  });

  test("snapshots: cleanup never touches migration backups or non-snapshot files", async () => {
    const backupDir = `${SNAP_HANDOFF_DIR}/history/migrations/2026-07-26T00-00-00-000Z`;
    const seed = {};
    seed[`${backupDir}/HANDOFF.md`] = "migration backup";
    seed[`${backupDir}/context.json`] = "{}";
    seed[`${SNAP_HANDOFF_DIR}/${SNAPSHOT_DIR}/notes.txt`] = "not a snapshot";
    const io = makeFakeIo(seed);

    for (let i = 0; i < SNAPSHOT_RETENTION + 2; i++) {
      await writeSnapshot(sampleSnapshotMap(`Goal ${i}`), SNAP_PATHS, io, {
        timestamp: `2026-07-28T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    assertEqual(io.store.get(`${backupDir}/HANDOFF.md`), "migration backup", "migration backup was touched");
    assertEqual(io.store.get(`${backupDir}/context.json`), "{}", "migration backup was touched");
    assertEqual(io.store.get(`${SNAP_HANDOFF_DIR}/${SNAPSHOT_DIR}/notes.txt`), "not a snapshot", "non-snapshot file was pruned");
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
  // are a Set of paths, symlinks/junctions a Map of linkPath -> target, and
  // text files a Map of path -> content.
  function makeLinkIo(seed = {}, failOn) {
    const dirs = new Set(seed.dirs || []);
    const links = new Map(Object.entries(seed.links || {}));
    const files = new Map(Object.entries(seed.files || {}));
    const ops = [];
    return {
      dirs,
      links,
      files,
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
      readFile: async (p) => (files.has(p) ? files.get(p) : null),
      writeFile: async (p, content) => {
        ops.push(["writeFile", p]);
        files.set(p, content);
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

  test("obsidian: validateAlias rejects wikilink and index-block injection", () => {
    // Newlines inject extra lines into the managed index block; `]]` closes
    // the wikilink early; `|`, `#`, `^` are Obsidian wikilink syntax; control
    // characters corrupt the note.
    for (const [label, a] of [
      ["newline", "alpha\n- [[evil]]"],
      ["carriage return", "alpha\r\nbeta"],
      ["wikilink close", "alpha]]"],
      ["wikilink pipe", "alpha|beta"],
      ["heading ref", "alpha#beta"],
      ["block ref", "alpha^beta"],
      ["control char", "alpha\u0007beta"],
    ]) {
      const r = validateAlias(a);
      assert(!r.valid, `${label} alias must be rejected`);
      assert(r.errors.length > 0, `${label} alias should report an error`);
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
    const provenance = linkProvenanceRecord({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT });
    const r = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin", provenance }, io);
    assert(r.ok, `unlink should succeed: ${r.message || ""}`);
    assertEqual(r.state, "unlinked");
    assert(!io.links.has(linkPath), "link must be removed");
    assert(io.dirs.has(HANDOFF_DIR), "the .handoff target must never be removed");
  });

  test("obsidian: link returns provenance for the user-level config", async () => {
    const io = makeLinkIo({ dirs: [VAULT, PROJECT, HANDOFF_DIR] });
    const r = await obsidianLink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(r.ok, `link should succeed: ${r.message || ""}`);
    assert(r.provenance, "a successful link must carry a provenance record");
    assertEqual(r.provenance.vaultPath, VAULT);
    assertEqual(r.provenance.alias, "proj");
    assertEqual(r.provenance.linkPath, linkPathFor(VAULT, "proj"));
    assertEqual(r.provenance.target, HANDOFF_DIR);
  });

  test("obsidian: unlink without provenance refuses and deletes nothing", async () => {
    // A user-crafted symlink to the same target is indistinguishable from an
    // Adapter-created one without a provenance record — it must survive.
    const linkPath = linkPathFor(VAULT, "proj");
    const io = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR],
      links: { [linkPath]: HANDOFF_DIR },
    });
    const r = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin" }, io);
    assert(!r.ok, "unlink without a provenance record must be refused");
    assertEqual(r.reason, "unverified-link");
    assert(/manual/i.test(r.message), `message should direct the user to remove it manually: ${r.message}`);
    assertEqual(io.links.get(linkPath), HANDOFF_DIR, "the unverified link must remain");
    assert(!io.ops.some((op) => op[0] === "unlink"), "nothing may be removed");
  });

  test("obsidian: unlink refuses a mismatched provenance record", async () => {
    const linkPath = linkPathFor(VAULT, "proj");
    const io = makeLinkIo({
      dirs: [VAULT, `${VAULT}/Projects`, HANDOFF_DIR],
      links: { [linkPath]: HANDOFF_DIR },
    });
    const provenance = linkProvenanceRecord({ vaultPath: VAULT, alias: "proj", projectDir: "/work/other-project" });
    const r = await obsidianUnlink({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT, platform: "darwin", provenance }, io);
    assert(!r.ok, "a provenance record for a different target must not authorize unlink");
    assertEqual(r.reason, "unverified-link");
    assertEqual(io.links.get(linkPath), HANDOFF_DIR, "the link must remain");
  });

  test("obsidian: provenance records round-trip through the user-level config", async () => {
    const record = linkProvenanceRecord({ vaultPath: VAULT, alias: "proj", projectDir: PROJECT });

    // Backward tolerance: missing, partial, and unknown-field configs.
    for (const config of [{}, { adapters: {} }, { adapters: { obsidian: { vaultPath: VAULT, future: 1 } } }, null]) {
      const hadObsidian = !!(config && config.adapters && config.adapters.obsidian);
      const next = recordLinkProvenance(config || {}, record);
      const found = findLinkProvenance(next, { vaultPath: VAULT, alias: "proj" });
      assert(found, `provenance must be found after recording, config: ${JSON.stringify(config)}`);
      assertEqual(found.target, record.target);
      assert(removeLinkProvenance(next, { vaultPath: VAULT, alias: "proj" }), "removal must report a change");
      assertEqual(findLinkProvenance(next, { vaultPath: VAULT, alias: "proj" }), null, "provenance must be gone after removal");
      if (hadObsidian) {
        assertEqual(next.adapters.obsidian.future, 1, "unknown user-config fields must be preserved");
        assertEqual(next.adapters.obsidian.vaultPath, VAULT, "vaultPath must be preserved");
      }
    }

    // Unknown lookups and repeat removals are clean no-ops.
    assertEqual(findLinkProvenance({}, { vaultPath: VAULT, alias: "proj" }), null);
    assertEqual(removeLinkProvenance({}, { vaultPath: VAULT, alias: "proj" }), false);
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

  test("config: adapters.obsidian rejects any vaultPath and undeclared keys", () => {
    const base = { version: "2.2.0", storage: { mode: "direct", path: ".handoff" } };
    for (const [label, obsidian] of [
      ["relative vaultPath", { enabled: true, vaultPath: "relative-vault" }],
      ["absolute vaultPath", { enabled: true, vaultPath: "/Users/alice/Documents/Vault" }],
      ["windows vaultPath", { vaultPath: "C:\\Vault" }],
      ["empty vaultPath", { vaultPath: "" }],
      ["unknown key", { enabled: true, theme: "dark" }],
      ["machine-specific relative key", { vaultDir: "relative-vault" }],
    ]) {
      const r = validateProjectConfig({ ...base, adapters: { obsidian } });
      assert(!r.valid, `${label} must be rejected`);
      assert(
        r.errors.some((e) => e.includes("adapters.obsidian") && /user-level config/.test(e)),
        `${label} error should point at the user-level config: ${JSON.stringify(r.errors)}`
      );
    }

    const ok = validateProjectConfig({
      ...base,
      adapters: { obsidian: { enabled: true, projectAlias: "handoff-protocol" } },
    });
    assert(ok.valid, `{enabled, projectAlias} must stay valid, errors: ${ok.errors.join("; ")}`);
  });

  // ── Semantic context diff (v2.3) ───────────────────────────────────────────

  const DIFF_HANDOFF_DIR = "/proj/.handoff";
  const DIFF_SNAP_DIR = `${DIFF_HANDOFF_DIR}/${SNAPSHOT_DIR}`;
  const DIFF_MAP_PATH = `${DIFF_HANDOFF_DIR}/context-map.md`;

  function diffState(nodesBySection) {
    const sections = {};
    for (const key of SECTION_KEYS) {
      sections[key] = (nodesBySection[key] || []).map((n) => ({ origin: "user", ...n }));
    }
    return { sections, extras: nodesBySection.extras || [] };
  }

  function diffSnapshotFile(state, timestamp = "2026-07-28T00-00-00-000Z") {
    const digest = snapshotDigest(state);
    return [`${DIFF_SNAP_DIR}/${timestamp}-${digest}.json`, JSON.stringify({
      version: PROTOCOL_VERSION,
      captured_at: timestamp,
      digest,
      state,
    }, null, 2)];
  }

  test("diff: no changes yields empty change classes", () => {
    const state = diffState({
      goal: [{ text: "Ship v2.3", depth: 0 }],
      tasks: [{ text: "Wire diff", depth: 0, checked: false }],
    });
    const model = diffStates(state, JSON.parse(JSON.stringify(state)));
    for (const key of ["added", "removed", "edited", "moved", "taskStateChanged"]) {
      assertEqual(model[key].length, 0, `${key} must be empty for identical states`);
    }
  });

  test("diff: added and removed nodes are reported separately", () => {
    const before = diffState({
      goal: [{ text: "Old goal", depth: 0 }],
      decisions: [{ text: "Drop this decision", depth: 0 }],
    });
    const after = diffState({
      goal: [{ text: "Old goal", depth: 0 }],
      risks: [{ text: "Brand new risk", depth: 0 }],
    });
    const model = diffStates(before, after);
    assertEqual(model.added.length, 1, "one added node expected");
    assertEqual(model.removed.length, 1, "one removed node expected");
    assertEqual(model.edited.length, 0, "cross-section changes must not be paired as edits");

    assertEqual(model.added[0].section, "risks");
    assertEqual(model.added[0].after, "Brand new risk");
    assert(!("before" in model.added[0]), "added entries carry no before text");

    assertEqual(model.removed[0].section, "decisions");
    assertEqual(model.removed[0].before, "Drop this decision");
    assert(!("after" in model.removed[0]), "removed entries carry no after text");

    // Edited pairing only applies within the same section and depth.
    const edited = diffStates(
      diffState({ status: [{ text: "Half done", depth: 0 }] }),
      diffState({ status: [{ text: "Nearly done", depth: 0 }] })
    );
    assertEqual(edited.edited.length, 1, "same-slot rewrite must be an edit");
    assertEqual(edited.edited[0].before, "Half done");
    assertEqual(edited.edited[0].after, "Nearly done");
    assertEqual(edited.added.length + edited.removed.length, 0, "an edit is not add+remove");
  });

  test("diff: moved nodes are reported once, not as remove+add", () => {
    const before = diffState({
      decisions: [{ text: "Parent", depth: 0 }, { text: "Child", depth: 1 }],
    });
    const after = diffState({
      decisions: [{ text: "Child", depth: 0 }, { text: "Parent", depth: 0 }],
    });
    const model = diffStates(before, after);
    assertEqual(model.added.length, 0, "moves must not surface as additions");
    assertEqual(model.removed.length, 0, "moves must not surface as removals");
    assertEqual(model.moved.length, 1, "only the re-parented node moved");
    const child = model.moved.find((m) => m.text === "Child");
    assertEqual(child.before.path, "Parent > Child");
    assertEqual(child.after.path, "Child");
    assertEqual(child.before.section, "decisions");
    assertEqual(child.after.section, "decisions");
  });

  test("diff: identical texts in different positions match by occurrence", () => {
    const before = diffState({
      decisions: [{ text: "Same", depth: 0 }, { text: "Same", depth: 0 }],
    });
    const after = diffState({
      decisions: [{ text: "Same", depth: 0 }, { text: "Same", depth: 0 }],
    });
    const model = diffStates(before, after);
    assertEqual(model.moved.length, 0, "identical duplicates in identical order must not move");
    assertEqual(model.added.length + model.removed.length, 0);
  });

  test("diff: task checkbox flips are task-state changes, not edits", () => {
    const before = diffState({
      tasks: [
        { text: "Wire diff", depth: 0, checked: false },
        { text: "Done already", depth: 0, checked: true },
      ],
    });
    const after = diffState({
      tasks: [
        { text: "Wire diff", depth: 0, checked: true },
        { text: "Done already", depth: 0, checked: true },
      ],
    });
    const model = diffStates(before, after);
    assertEqual(model.taskStateChanged.length, 1);
    assertEqual(model.edited.length, 0, "a checkbox flip is not a text edit");
    const change = model.taskStateChanged[0];
    assertEqual(change.section, "tasks");
    assertEqual(change.path, "Wire diff");
    assertEqual(change.task.before, false);
    assertEqual(change.task.after, true);
  });

  test("diff: mixed changes populate every class independently", () => {
    const before = diffState({
      goal: [{ text: "Keep", depth: 0 }],
      tasks: [{ text: "Flip me", depth: 0, checked: false }],
      decisions: [
        { text: "Move me", depth: 0 },
        { text: "Edit me", depth: 0 },
        { text: "Remove me", depth: 0 },
      ],
    });
    const after = diffState({
      goal: [{ text: "Keep", depth: 0 }],
      tasks: [{ text: "Flip me", depth: 0, checked: true }],
      decisions: [{ text: "Edit me instead", depth: 0 }],
      risks: [
        { text: "Move me", depth: 0 },
        { text: "Fresh risk", depth: 0 },
      ],
    });
    const model = diffStates(before, after);
    assertEqual(model.added.length, 1);
    assertEqual(model.added[0].section, "risks");
    assertEqual(model.removed.length, 1);
    assertEqual(model.removed[0].before, "Remove me");
    assertEqual(model.edited.length, 1);
    assertEqual(model.edited[0].before, "Edit me");
    assertEqual(model.edited[0].after, "Edit me instead");
    assertEqual(model.moved.length, 1);
    assertEqual(model.moved[0].text, "Move me");
    assertEqual(model.taskStateChanged.length, 1);
    assertEqual(model.taskStateChanged[0].path, "Flip me");
  });

  test("diff: JSON and Markdown render the same model", () => {
    const before = diffState({
      tasks: [{ text: "Flip me", depth: 0, checked: false }],
      decisions: [{ text: "Gone", depth: 0 }],
    });
    const after = diffState({
      tasks: [{ text: "Flip me", depth: 0, checked: true }],
      decisions: [{ text: "Here", depth: 0 }],
    });
    const model = diffStates(before, after);
    const meta = { from: "latest", snapshotId: "snap-1", capturedAt: "2026-07-28T00:00:00.000Z" };

    const json = JSON.parse(renderDiffJson(model, meta));
    assertEqual(json.snapshot.id, "snap-1");
    for (const key of ["added", "removed", "edited", "moved", "taskStateChanged"]) {
      assert(Array.isArray(json[key]), `json.${key} must be an array`);
      assertEqual(json[key].length, model[key].length, `json.${key} diverges from the model`);
    }

    const md = renderDiffMarkdown(model, meta);
    assertIncludes(md, "Context diff");
    assertIncludes(md, "snap-1");
    assertIncludes(md, "Added");
    assertIncludes(md, "Removed");
    assertIncludes(md, "Edited");
    assertIncludes(md, "Moved");
    assertIncludes(md, "Task state changed");
    assertIncludes(md, "Here");
    assertIncludes(md, "Gone");
    assertIncludes(md, "Flip me");

    const empty = renderDiffMarkdown(diffStates(before, JSON.parse(JSON.stringify(before))), meta);
    assertIncludes(empty, "No changes", "an empty diff should say so");
  });

  test("diff: output is sensitive-filtered even from a hostile snapshot", () => {
    const before = diffState({
      knowledge: [{ text: "deploy key: api_key=abcdefghijklmnop123456", depth: 0 }],
    });
    const after = diffState({ knowledge: [{ text: "rotated", depth: 0 }] });
    const model = diffStates(before, after);
    for (const out of [renderDiffJson(model, {}), renderDiffMarkdown(model, {})]) {
      assertNotIncludes(out, "abcdefghijklmnop123456", "raw secret leaked into diff output");
      assertIncludes(out, "[REDACTED]");
    }
  });

  test("diff: runDiff defaults to the latest snapshot and never mutates", async () => {
    const before = diffState({
      goal: [{ text: "Old goal", depth: 0 }],
      tasks: [{ text: "Flip", depth: 0, checked: false }],
    });
    const [snapName, snapBody] = diffSnapshotFile(before, "2026-07-28T00-00-00-000Z");
    const afterMap = emptyContextMap();
    afterMap.sections.goal.push({ text: "New goal", origin: "agent", depth: 0 });
    afterMap.sections.tasks.push({ text: "Flip", origin: "user", depth: 0, checked: true });
    const mapBody = renderContextMap(afterMap, { lang: "en" });
    const io = makeFakeIo({ [snapName]: snapBody, [DIFF_MAP_PATH]: mapBody });

    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io);
    assert(result.ok, `runDiff failed: ${result.error}`);
    assertEqual(result.format, "markdown", "default format must be markdown");
    assertEqual(result.snapshot.id, snapName.split("/").pop().replace(/\.json$/, ""));
    assertIncludes(result.output, "New goal");
    assertIncludes(result.output, "Old goal");

    const parsed = JSON.parse(renderDiffJson(result.model, {}));
    assertEqual(parsed.edited.length, 1, "goal rewrite must be an edit");
    assertEqual(parsed.taskStateChanged.length, 1, "task flip must be reported");

    // Read-only contract: nothing was written, moved, or removed.
    assertEqual(io.ops.length, 0, `diff must not mutate state, ops: ${JSON.stringify(io.ops)}`);
    assertEqual(io.store.get(snapName), snapBody, "snapshot file changed");
    assertEqual(io.store.get(DIFF_MAP_PATH), mapBody, "context map changed");
  });

  test("diff: default baseline falls back to the previous snapshot after save", async () => {
    // save → diff: the newest snapshot equals the current state, so the
    // default comparison must use the PREVIOUS snapshot and show the last
    // real change instead of reporting "no changes".
    const before = diffState({ goal: [{ text: "Old goal", depth: 0 }] });
    const [oldName, oldBody] = diffSnapshotFile(before, "2026-07-28T00-00-00-000Z");
    const currentMap = emptyContextMap();
    currentMap.sections.goal.push({ text: "New goal", origin: "user", depth: 0 });
    const [newName, newBody] = diffSnapshotFile(buildSnapshot(currentMap), "2026-07-28T01-00-00-000Z");
    const io = makeFakeIo({
      [oldName]: oldBody,
      [newName]: newBody,
      [DIFF_MAP_PATH]: renderContextMap(currentMap, { lang: "en" }),
    });

    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io);
    assert(result.ok, `runDiff failed: ${result.error}`);
    assertEqual(
      result.snapshot.id,
      oldName.split("/").pop().replace(/\.json$/, ""),
      "default baseline must be the previous snapshot, not the newest"
    );
    assertIncludes(result.output, "Old goal");
    assertIncludes(result.output, "New goal");
    assertNotIncludes(result.output, "No changes");
  });

  test("diff: default baseline stays the newest snapshot with unsaved changes", async () => {
    // The map drifted since the last save: the newest snapshot differs from
    // the current state and remains the default baseline.
    const saved = diffState({ goal: [{ text: "Saved goal", depth: 0 }] });
    const [snapName, snapBody] = diffSnapshotFile(saved, "2026-07-28T00-00-00-000Z");
    const currentMap = emptyContextMap();
    currentMap.sections.goal.push({ text: "Unsaved edit", origin: "user", depth: 0 });
    const io = makeFakeIo({
      [snapName]: snapBody,
      [DIFF_MAP_PATH]: renderContextMap(currentMap, { lang: "en" }),
    });

    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io);
    assert(result.ok, `runDiff failed: ${result.error}`);
    assertEqual(result.snapshot.id, snapName.split("/").pop().replace(/\.json$/, ""));
    assertIncludes(result.output, "Saved goal");
    assertIncludes(result.output, "Unsaved edit");
  });

  test("diff: explicit --from latest keeps the literal newest snapshot", async () => {
    const before = diffState({ goal: [{ text: "Old goal", depth: 0 }] });
    const [oldName, oldBody] = diffSnapshotFile(before, "2026-07-28T00-00-00-000Z");
    const currentMap = emptyContextMap();
    currentMap.sections.goal.push({ text: "New goal", origin: "user", depth: 0 });
    const [newName, newBody] = diffSnapshotFile(buildSnapshot(currentMap), "2026-07-28T01-00-00-000Z");
    const io = makeFakeIo({
      [oldName]: oldBody,
      [newName]: newBody,
      [DIFF_MAP_PATH]: renderContextMap(currentMap, { lang: "en" }),
    });

    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io, { from: "latest" });
    assert(result.ok, `runDiff failed: ${result.error}`);
    assertEqual(
      result.snapshot.id,
      newName.split("/").pop().replace(/\.json$/, ""),
      "--from latest must pick the newest snapshot even when it equals the current state"
    );
    assertIncludes(result.output, "No changes");
  });

  test("diff: no eligible default baseline is a clear actionable error", async () => {
    // A single snapshot that already equals the current state: there is no
    // previous snapshot to compare against.
    const currentMap = emptyContextMap();
    currentMap.sections.goal.push({ text: "Only goal", origin: "user", depth: 0 });
    const [snapName, snapBody] = diffSnapshotFile(buildSnapshot(currentMap), "2026-07-28T00-00-00-000Z");
    const io = makeFakeIo({
      [snapName]: snapBody,
      [DIFF_MAP_PATH]: renderContextMap(currentMap, { lang: "en" }),
    });

    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io);
    assert(!result.ok, "a missing earlier baseline must fail");
    assertIncludes(result.error, "current state", "error should explain the situation");
    assert(result.guidance && result.guidance.includes("--from"), `guidance should be actionable: ${result.guidance}`);
  });

  test("diff: runDiff selects a snapshot by id and honors --format json", async () => {
    const older = diffState({ goal: [{ text: "v1", depth: 0 }] });
    const newer = diffState({ goal: [{ text: "v2", depth: 0 }] });
    const [oldName, oldBody] = diffSnapshotFile(older, "2026-07-28T00-00-00-000Z");
    const [newName, newBody] = diffSnapshotFile(newer, "2026-07-28T01-00-00-000Z");
    const afterMap = emptyContextMap();
    afterMap.sections.goal.push({ text: "v3", origin: "user", depth: 0 });
    const io = makeFakeIo({
      [oldName]: oldBody,
      [newName]: newBody,
      [DIFF_MAP_PATH]: renderContextMap(afterMap, { lang: "en" }),
    });

    const oldId = oldName.split("/").pop().replace(/\.json$/, "");
    const result = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io, { from: oldId, format: "json" });
    assert(result.ok, `runDiff failed: ${result.error}`);
    assertEqual(result.snapshot.id, oldId, "explicit --from id must win over the latest snapshot");
    const json = JSON.parse(result.output);
    assertEqual(json.edited[0].before, "v1", "diff must compare against the requested snapshot");
    assertEqual(json.edited[0].after, "v3");
  });

  test("diff: unknown or malformed snapshot ids are actionable errors", async () => {
    const state = diffState({ goal: [{ text: "v1", depth: 0 }] });
    const [snapName, snapBody] = diffSnapshotFile(state);
    const io = makeFakeIo({
      [snapName]: snapBody,
      [DIFF_MAP_PATH]: renderContextMap(emptyContextMap(), { lang: "en" }),
    });

    const unknown = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io, { from: "1999-01-01T00-00-00-000Z-deadbeef" });
    assert(!unknown.ok, "unknown snapshot id must fail");
    assertIncludes(unknown.error, "1999-01-01T00-00-00-000Z-deadbeef");

    const invalid = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io, { from: "../../etc/passwd" });
    assert(!invalid.ok, "malformed snapshot id must fail");
    assertIncludes(invalid.error, "invalid", "error should call the id invalid");

    const badFormat = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io, { format: "yaml" });
    assert(!badFormat.ok, "unknown format must fail");
    assertIncludes(badFormat.error, "markdown", "error should list valid formats");
    assertIncludes(badFormat.error, "json", "error should list valid formats");
  });

  test("diff: missing snapshots and malformed snapshot files fail cleanly", async () => {
    const io = makeFakeIo({ [DIFF_MAP_PATH]: renderContextMap(emptyContextMap(), { lang: "en" }) });
    const none = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, io);
    assert(!none.ok, "no snapshots must fail");
    assertIncludes(none.error, "snapshot");

    const broken = makeFakeIo({
      [`${DIFF_SNAP_DIR}/2026-07-28T00-00-00-000Z-abcdef01.json`]: "{ not json",
      [DIFF_MAP_PATH]: renderContextMap(emptyContextMap(), { lang: "en" }),
    });
    const malformed = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, broken, { from: "2026-07-28T00-00-00-000Z-abcdef01" });
    assert(!malformed.ok, "unparseable snapshot must fail");
    assertIncludes(malformed.error, "malformed");

    const noState = makeFakeIo({
      [`${DIFF_SNAP_DIR}/2026-07-28T00-00-00-000Z-abcdef02.json`]: JSON.stringify({ version: "2.0.0" }),
      [DIFF_MAP_PATH]: renderContextMap(emptyContextMap(), { lang: "en" }),
    });
    const missing = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, noState, { from: "2026-07-28T00-00-00-000Z-abcdef02" });
    assert(!missing.ok, "snapshot without state must fail");
    assertIncludes(missing.error, "malformed");

    const noMap = makeFakeIo({});
    const noMapResult = await runDiff({ handoffDir: DIFF_HANDOFF_DIR }, noMap, { from: "whatever" });
    assert(!noMapResult.ok, "missing context map must fail");
    assertIncludes(noMapResult.error, "context-map.md");
  });
}

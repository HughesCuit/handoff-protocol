// @ts-nocheck
/**
 * Handoff Protocol v1.5 — Context Map core.
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno implementation
 * (scripts/save.ts, scripts/load.ts) and the Node.js implementation
 * (scripts/node/save.mjs, scripts/node/load.mjs). It intentionally uses no
 * runtime-specific APIs (no `Deno.*`, no `node:*`) so behavior stays
 * identical across runtimes.
 *
 * Context Map model
 * -----------------
 * `.handoff/context-map.md` is a human-editable Markdown tree with eight
 * fixed semantic sections. Section headings may be localized; an internal
 * label mapping resolves them back to the fixed keys on parse.
 *
 * Each list item (bullet or numbered) under a section is a "node": a concise,
 * independently understandable statement. Indentation is retained as `depth`
 * so parent-child relationships survive parse/reconcile/render cycles. Nodes
 * carry an origin:
 *   - "user"  — written or edited by a human; always wins over inference.
 *   - "agent" — inferred by `/handoff save`; suffixed with AGENT_MARKER and
 *               a content fingerprint. Editing its text or task state makes
 *               the fingerprint stale and transfers ownership to the user.
 *               Unedited agent nodes may be replaced by fresh inference.
 *
 * Unknown sections are preserved verbatim ("extras") after the known ones so
 * reconciliation never silently discards user content.
 */

export const PROTOCOL_VERSION = "2.0.0";
export const CONTEXT_MAP_FILE = "context-map.md";
/** Alias kept for callers that use the shorter name. */
export const MAP_FILENAME = CONTEXT_MAP_FILE;
/** All files a save writes and a submodule commit includes. */
export const HANDOFF_FILES = [
  "HANDOFF.md",
  "context.json",
  "tasks.md",
  "decisions.md",
  CONTEXT_MAP_FILE,
];
export const AGENT_MARKER = "<!-- agent -->";
const AGENT_HASH_RE = /<!--\s*agent-hash:([0-9a-f]{8})\s*-->\s*$/i;

export const SECTION_KEYS = [
  "goal",
  "status",
  "tasks",
  "decisions",
  "questions",
  "risks",
  "knowledge",
  "excluded",
];

/** Sections that hold a single statement; user content suppresses inference. */
const SINGLETON_SECTIONS = new Set(["goal", "status"]);

export const SECTION_LABELS = {
  goal: {
    en: "Current Goal", zh: "当前目标", ja: "現在の目標", ko: "현재 목표",
    de: "Aktuelles Ziel", fr: "Objectif actuel", es: "Objetivo actual",
  },
  status: {
    en: "Current Status", zh: "当前状态", ja: "現在のステータス", ko: "현재 상태",
    de: "Aktueller Status", fr: "État actuel", es: "Estado actual",
  },
  tasks: {
    en: "Tasks", zh: "任务", ja: "タスク", ko: "작업",
    de: "Aufgaben", fr: "Tâches", es: "Tareas",
  },
  decisions: {
    en: "Decisions", zh: "决策", ja: "決定", ko: "결정",
    de: "Entscheidungen", fr: "Décisions", es: "Decisiones",
  },
  questions: {
    en: "Open Questions", zh: "未决问题", ja: "未解決の質問", ko: "미해결 질문",
    de: "Offene Fragen", fr: "Questions ouvertes", es: "Preguntas abiertas",
  },
  risks: {
    en: "Risks", zh: "风险", ja: "リスク", ko: "위험",
    de: "Risiken", fr: "Risques", es: "Riesgos",
  },
  knowledge: {
    en: "Knowledge and Notes", zh: "知识与备注", ja: "知識とメモ", ko: "지식과 노트",
    de: "Wissen und Notizen", fr: "Connaissances et notes", es: "Conocimientos y notas",
  },
  excluded: {
    en: "Excluded", zh: "已排除", ja: "除外", ko: "제외됨",
    de: "Ausgeschlossen", fr: "Exclu", es: "Excluido",
  },
};

const LABEL_TO_KEY = new Map();
for (const [key, labels] of Object.entries(SECTION_LABELS)) {
  for (const label of Object.values(labels)) {
    LABEL_TO_KEY.set(label.trim().toLowerCase(), key);
  }
}

/** Resolve a (possibly localized) section heading to its semantic key. */
export function sectionKeyForLabel(label) {
  return LABEL_TO_KEY.get(String(label).trim().toLowerCase()) || null;
}

// ── Security ─────────────────────────────────────────────────────────────────
// Keep in sync with the pattern lists in the save/load scripts.

const SENSITIVE_PATTERNS = [
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9\-]{16,}["']?/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]{20,}=*/gi,
  /cookie\s*:\s*[^\n]+/gi,
  /password\s*[:=]\s*["']?[^\s"']+["']?/gi,
  /private[_-]?key\s*[:=]\s*-----BEGIN/gi,
  /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  /gh[pousr]_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9\-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(?:secret|token|credential)\s*[:=]\s*["']?[a-zA-Z0-9\-._]{16,}["']?/gi,
  /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@[^\s"']+["']?/gi,
  /(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|GCP_KEY)\s*[:=]\s*["']?[^\s"']+["']?/gi,
  /(?:xox[bpsa]-[a-zA-Z0-9-]+)/g,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
];

export function filterSensitive(text) {
  let filtered = String(text);
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, "[REDACTED]");
  }
  return filtered;
}

// ── Map structure ────────────────────────────────────────────────────────────

export function emptyContextMap() {
  const sections = {};
  for (const key of SECTION_KEYS) sections[key] = [];
  return { sections, extras: [] };
}

export function contextMapHasContent(map) {
  if (!map || !map.sections) return false;
  const hasNodes = SECTION_KEYS.some((key) => (map.sections[key] || []).length > 0);
  const hasExtras = (map.extras || []).some((e) => e.body.some((l) => l.trim()));
  return hasNodes || hasExtras;
}

/** Normalize node text for semantic-duplicate detection. */
export function normalizeNodeText(text) {
  return String(text)
    .replace(/<!--\s*agent\s*-->/gi, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^\*\*(high|medium|low)\*\*\s+/i, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.。]+$/, "");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const HR_RE = /^-{3,}\s*$/;
const FOOTER_RE = /^\*Generated by Handoff Protocol/;
const COMMENT_RE = /^<!--[\s\S]*-->\s*$/;
function nodeFingerprint(text, checked = false) {
  const input = `${checked ? "1" : "0"}:${String(text)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function indentationWidth(indent) {
  let width = 0;
  for (const char of indent) width += char === "\t" ? 4 : 1;
  return width;
}

/**
 * Parse context-map Markdown into a map object.
 * Returns null when the content is empty or contains no recognized section
 * heading — callers treat null as "absent or malformed" and fall back to the
 * legacy loading path.
 */
export function parseContextMap(content) {
  if (!content || !String(content).trim()) return null;

  const map = emptyContextMap();
  let currentKey = null;
  let currentExtra = null;
  let recognized = 0;
  let indentationLevels = [0];

  for (const rawLine of String(content).split("\n")) {
    const trimmed = rawLine.trim();

    // Footer / horizontal rule terminates the map body.
    if (HR_RE.test(trimmed) || FOOTER_RE.test(trimmed)) break;
    if (!trimmed || COMMENT_RE.test(trimmed)) continue;
    if (/^#\s/.test(trimmed)) continue; // document title

    const heading = trimmed.match(/^##\s+(.+?)\s*$/);
    if (heading && !trimmed.startsWith("###")) {
      currentKey = sectionKeyForLabel(heading[1]);
      if (currentKey) {
        recognized++;
        currentExtra = null;
        indentationLevels = [0];
      } else {
        currentExtra = { heading: heading[1], body: [] };
        map.extras.push(currentExtra);
      }
      continue;
    }

    if (currentKey) {
      const item = rawLine.match(/^(\s*)(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
      if (!item) continue;

      const width = indentationWidth(item[1]);
      while (indentationLevels.length > 1 && width < indentationLevels.at(-1)) {
        indentationLevels.pop();
      }
      if (width > indentationLevels.at(-1)) indentationLevels.push(width);
      const depth = indentationLevels.length - 1;

      let text = item[2];
      let origin = "user";
      let storedHash = null;
      const hashMatch = text.match(AGENT_HASH_RE);
      if (hashMatch) {
        storedHash = hashMatch[1].toLowerCase();
        text = text.replace(AGENT_HASH_RE, "").trim();
      }
      const hasAgentMarker = /<!--\s*agent\s*-->\s*$/.test(text);
      if (hasAgentMarker) {
        text = text.replace(/<!--\s*agent\s*-->\s*$/, "").trim();
      }

      const node = { text, origin, depth };
      if (currentKey === "tasks") {
        const cb = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (cb) {
          node.checked = cb[1].toLowerCase() === "x";
          node.text = cb[2].trim();
        } else {
          node.checked = false;
        }
      }
      if (
        hasAgentMarker &&
        (!storedHash || storedHash === nodeFingerprint(node.text, !!node.checked))
      ) {
        node.origin = "agent";
      }
      map.sections[currentKey].push(node);
    } else if (currentExtra) {
      currentExtra.body.push(rawLine.replace(/\s+$/, ""));
    }
  }

  if (recognized === 0) return null;
  return map;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderContextMap(map, opts = {}) {
  const lang = opts.lang && SECTION_LABELS.goal[opts.lang] ? opts.lang : "en";
  const chunks = [
    "# Context Map\n\n" +
      `<!-- handoff-protocol:v${PROTOCOL_VERSION} — Human-editable context index. ` +
      "Nested indentation expresses parent-child relationships. Agent-generated " +
      "nodes carry a marker and content fingerprint; editing their text or task " +
      "state automatically transfers ownership to you. -->",
  ];

  for (const key of SECTION_KEYS) {
    const lines = [`## ${SECTION_LABELS[key][lang]}`, ""];
    for (const node of map.sections[key] || []) {
      let text = node.text;
      if (key === "tasks") text = `[${node.checked ? "x" : " "}] ${text}`;
      const marker = node.origin === "agent"
        ? ` ${AGENT_MARKER} <!-- agent-hash:${nodeFingerprint(node.text, !!node.checked)} -->`
        : "";
      const indent = "  ".repeat(Math.max(0, Number(node.depth) || 0));
      lines.push(`${indent}- ${text}${marker}`);
    }
    chunks.push(lines.join("\n").replace(/\s+$/, ""));
  }

  for (const extra of map.extras || []) {
    chunks.push(`## ${extra.heading}\n${extra.body.join("\n")}`.replace(/\s+$/, ""));
  }

  chunks.push(`---\n\n*Generated by Handoff Protocol v${PROTOCOL_VERSION}*`);
  return chunks.join("\n\n") + "\n";
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Reconcile an existing map (or null) with freshly inferred section content.
 *
 * Rules:
 *  - User nodes are always preserved, verbatim and in order.
 *  - Singleton sections (goal/status): if the user wrote a node, inference is
 *    suppressed entirely for that section.
 *  - Agent nodes are replaced by the new inference for that section — but
 *    only when the inference is non-empty, so low-detail saves preserve the
 *    existing map.
 *  - An inferred node that is a semantic duplicate of an existing node is not
 *    appended.
 *  - Unknown sections (extras) pass through untouched.
 *
 * `inferred` shape: { [sectionKey]: [{ text, checked? }] }.
 */
export function reconcileContextMap(existing, inferred, _opts = {}) {
  const result = emptyContextMap();
  const prior = existing || emptyContextMap();

  for (const key of SECTION_KEYS) {
    const priorNodes = prior.sections[key] || [];
    const userNodes = priorNodes.filter((n) => n.origin !== "agent");
    const inferredNodes = (inferred && inferred[key]) || [];

    if (SINGLETON_SECTIONS.has(key) && userNodes.length > 0) {
      result.sections[key] = userNodes;
      continue;
    }

    const seen = new Set(userNodes.map((n) => normalizeNodeText(n.text)));
    const next = [...userNodes];

    if (inferredNodes.length > 0) {
      for (const entry of inferredNodes) {
        const text = String(entry.text || "").trim();
        if (!text) continue;
        const norm = normalizeNodeText(text);
        if (seen.has(norm)) continue; // semantic duplicate
        seen.add(norm);
        next.push({
          text,
          origin: "agent",
          checked: !!entry.checked,
          depth: Math.max(0, Number(entry.depth) || 0),
        });
      }
    } else {
      // No new inference for this section: keep prior agent nodes too.
      next.push(...priorNodes.filter((n) => n.origin === "agent"));
    }

    result.sections[key] = next;
  }

  result.extras = (prior.extras || []).map((e) => ({ heading: e.heading, body: [...e.body] }));
  return result;
}

// ── Inference from a HandoffContext (save path) ─────────────────────────────

/** Derive inferred Context Map sections from a saved HandoffContext. */
export function buildInferredSections(ctx) {
  const inferred = {};
  for (const key of SECTION_KEYS) inferred[key] = [];

  const goal = String(ctx.current_goal || "").split("\n")[0].trim();
  if (goal) inferred.goal.push({ text: goal });

  const status = String(ctx.status || "").trim();
  if (status) inferred.status.push({ text: status });

  for (const todo of ctx.todos || []) {
    if (!todo.task) continue;
    inferred.tasks.push({
      text: `**${todo.priority || "medium"}** ${todo.task}`,
      checked: todo.status === "completed",
    });
  }
  for (const step of ctx.next_steps || []) {
    if (step) inferred.tasks.push({ text: String(step), checked: false });
  }

  for (const d of ctx.decisions || []) {
    const text = d.title ? `${d.title}: ${d.decision}` : String(d.decision || "");
    if (text.trim()) inferred.decisions.push({ text: text.trim() });
  }

  for (const risk of [...(ctx.risks || []), ...(ctx.blockers || [])]) {
    if (risk) inferred.risks.push({ text: String(risk) });
  }

  for (const line of String(ctx.notes || "").split("\n")) {
    const text = line.trim();
    if (text) inferred.knowledge.push({ text });
  }

  return inferred;
}

// ── Load-path state projection ───────────────────────────────────────────────

/**
 * True when a parsed map carries usable semantic content. Accepts null so it
 * can guard parseContextMap results directly (absent/empty/malformed maps
 * fall back to the legacy load path).
 */
export function hasSemanticSections(map) {
  return contextMapHasContent(map);
}

/** Project a parsed map into a flat semantic state for the load scripts. */
export function contextMapToState(map) {
  const texts = (key) => (map.sections[key] || []).map((n) => n.text);

  const tasks = (map.sections.tasks || []).map((node) => {
    const m = node.text.match(/^\*\*(high|medium|low)\*\*\s+([\s\S]*)$/i);
    return {
      text: m ? m[2] : node.text,
      priority: m ? m[1].toLowerCase() : "medium",
      done: !!node.checked,
    };
  });

  return {
    goal: texts("goal").join("\n"),
    status: texts("status").join("\n"),
    tasks,
    decisions: texts("decisions"),
    openQuestions: texts("questions"),
    risks: texts("risks"),
    knowledge: texts("knowledge"),
    excluded: texts("excluded"),
  };
}

// ── Projection back to HandoffContext (load path) ───────────────────────────

/** Project Context Map semantics into HandoffContext-shaped fields. */
export function contextMapToContext(map) {
  const text = (key) => (map.sections[key] || []).map((n) => n.text);

  const todos = text("tasks").map((t, i) => {
    const node = map.sections.tasks[i];
    const m = t.match(/^\*\*(high|medium|low)\*\*\s+([\s\S]*)$/i);
    return {
      task: m ? m[2] : t,
      priority: m ? m[1].toLowerCase() : "medium",
      status: node.checked ? "completed" : "pending",
    };
  });

  const decisions = text("decisions").map((d) => {
    const m = d.match(/^([^:]{1,80}):\s+([\s\S]*)$/);
    return m
      ? { title: m[1].trim(), context: "", decision: m[2].trim(), rationale: "" }
      : { title: "", context: "", decision: d, rationale: "" };
  });

  return {
    current_goal: text("goal").join("\n"),
    status: text("status").join("\n"),
    todos,
    decisions,
    risks: text("risks"),
    notes: text("knowledge").join("\n"),
  };
}

/**
 * Merge map semantics with legacy machine state.
 *
 * The map wins for semantic fields (goal, status, todos, decisions, risks,
 * notes); context.json supplements machine state (project, agent, git,
 * timestamps, modified files, completed work) and any semantic field the map
 * leaves empty. Works with a null `json` for map-only handoffs.
 */
export function mergeContextMapWithJson(map, json) {
  const fromMap = contextMapToContext(map);
  const base = json || {};

  return {
    version: base.version || PROTOCOL_VERSION,
    timestamp: base.timestamp || "",
    agent: base.agent || "unknown",
    project: base.project || "unknown",
    current_goal: fromMap.current_goal || base.current_goal || "",
    status: fromMap.status || base.status || "unknown",
    completed: base.completed || [],
    modified_files: base.modified_files || [],
    todos: fromMap.todos.length > 0 ? fromMap.todos : base.todos || [],
    blockers: base.blockers || [],
    decisions: fromMap.decisions.length > 0 ? fromMap.decisions : base.decisions || [],
    next_steps: base.next_steps || [],
    git: base.git || { branch: "unknown", latest_commit: "", commit_message: "", is_dirty: false },
    risks: fromMap.risks.length > 0 ? fromMap.risks : base.risks || [],
    notes: fromMap.notes || base.notes || "",
    lang: base.lang,
    verbosity: base.verbosity,
  };
}

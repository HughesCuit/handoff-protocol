// @ts-nocheck
/**
 * Handoff Protocol v1.5.1 — TODO comment extraction (shared core).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Deno save script
 * (scripts/save.ts) and the Node.js save script (scripts/node/save.mjs). It
 * intentionally uses no runtime-specific APIs (no `Deno.*`, no `node:*`) so
 * behavior stays identical across runtimes.
 *
 * extractTodoComments() is comment-aware: it tokenizes source into code,
 * strings, and comments, and only scans comment bodies for TODO-style tags.
 * Tags inside ordinary strings, template literals, docstrings, generated
 * output text, or Markdown examples embedded in strings are NOT reported.
 */

/** File extensions the repository TODO scan covers. */
export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

/**
 * Directory names excluded from repository-wide scans: handoff state, test
 * fixtures, generated/build output, dependencies, and VCS metadata.
 */
export const SCAN_EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn",
  ".handoff",
  "node_modules", "vendor", "__pycache__",
  "dist", "build", "out", "coverage",
  "fixtures",
]);

const TODO_TAG_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s]+([^\n]+)/gi;

const C_STYLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".php", ".swift", ".kt",
]);
const HASH_STYLE_EXTENSIONS = new Set([".py", ".rb"]);

/**
 * Extract TODO/FIXME/HACK/XXX tags from the comments of a source file.
 * `extension` selects the comment syntax (".ts", ".py", ...); unknown
 * extensions yield no results. Returns Array<{ tag, text, line }> with
 * 1-based line numbers, in source order.
 */
export function extractTodoComments(source, extension) {
  const ext = String(extension || "").toLowerCase();
  let comments;
  if (C_STYLE_EXTENSIONS.has(ext)) {
    comments = scanCStyle(String(source), { hashLineComments: ext === ".php" });
  } else if (HASH_STYLE_EXTENSIONS.has(ext)) {
    comments = scanHashStyle(String(source), { rubyBlocks: ext === ".rb" });
  } else {
    return [];
  }

  const results = [];
  for (const comment of comments) {
    const lines = comment.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      TODO_TAG_RE.lastIndex = 0;
      let match;
      while ((match = TODO_TAG_RE.exec(lines[i])) !== null) {
        results.push({
          tag: match[1].toUpperCase(),
          text: match[2].trim(),
          line: comment.line + i,
        });
      }
    }
  }
  return results;
}

// ── C-style languages (// and /* ... */ comments; ', ", ` strings) ───────────

function scanCStyle(source, { hashLineComments = false } = {}) {
  const comments = [];
  const stack = ["code"];
  let line = 1;
  let buf = "";
  let commentLine = 1;
  let interpDepth = 0; // brace depth inside a template literal ${...}
  const top = () => stack[stack.length - 1];

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    const state = top();
    if (c === "\n") line++;

    if (state === "line") {
      if (c === "\n") {
        comments.push({ text: buf, line: commentLine });
        stack.pop();
      } else {
        buf += c;
      }
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        comments.push({ text: buf, line: commentLine });
        stack.pop();
        i++;
      } else {
        buf += c;
      }
      continue;
    }
    if (state === "squote" || state === "dquote") {
      if (c === "\\") {
        if (source[i + 1] === "\n") line++;
        i++;
        continue;
      }
      if (c === (state === "squote" ? "'" : '"')) stack.pop();
      continue;
    }
    if (state === "template") {
      if (c === "\\") {
        if (source[i + 1] === "\n") line++;
        i++;
        continue;
      }
      if (c === "`") stack.pop();
      else if (c === "$" && n === "{") {
        stack.push("interp");
        interpDepth = 0;
        i++;
      }
      continue;
    }

    // code, or an interpolation (code inside a template ${...})
    if (state === "interp") {
      if (c === "{") interpDepth++;
      else if (c === "}") {
        if (interpDepth === 0) {
          stack.pop();
          continue;
        }
        interpDepth--;
      }
    }
    if (c === "/" && n === "/") {
      stack.push("line");
      buf = "";
      commentLine = line;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      stack.push("block");
      buf = "";
      commentLine = line;
      i++;
      continue;
    }
    if (hashLineComments && c === "#") {
      stack.push("line");
      buf = "";
      commentLine = line;
      continue;
    }
    if (c === "'") { stack.push("squote"); continue; }
    if (c === '"') { stack.push("dquote"); continue; }
    if (c === "`") { stack.push("template"); continue; }
  }

  // Unterminated comment at EOF: its content is still comment text.
  if (top() === "line" || top() === "block") {
    comments.push({ text: buf, line: commentLine });
  }
  return comments;
}

// ── Hash-comment languages (.py, .rb) ────────────────────────────────────────

function scanHashStyle(source, { rubyBlocks = false } = {}) {
  const comments = [];
  const stack = ["code"];
  let line = 1;
  let buf = "";
  let commentLine = 1;
  const top = () => stack[stack.length - 1];
  const atLineStart = (i) => i === 0 || source[i - 1] === "\n";

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const state = top();
    if (c === "\n") line++;

    if (state === "line") {
      if (c === "\n") {
        comments.push({ text: buf, line: commentLine });
        stack.pop();
      } else {
        buf += c;
      }
      continue;
    }
    if (state === "rublock") {
      if (c === "=" && atLineStart(i) && source.startsWith("=end", i)) {
        comments.push({ text: buf, line: commentLine });
        stack.pop();
        i += 3;
        continue;
      }
      buf += c;
      continue;
    }
    if (state === "squote" || state === "dquote") {
      if (c === "\\") {
        if (source[i + 1] === "\n") line++;
        i++;
        continue;
      }
      if (c === (state === "squote" ? "'" : '"')) stack.pop();
      continue;
    }
    if (state === "tsquote" || state === "tdquote") {
      const quotes = state === "tsquote" ? "'''" : '"""';
      if (c === "\\") {
        if (source[i + 1] === "\n") line++;
        i++;
        continue;
      }
      if (source.startsWith(quotes, i)) {
        stack.pop();
        i += 2;
      }
      continue;
    }

    // code
    if (c === "#") {
      stack.push("line");
      buf = "";
      commentLine = line;
      continue;
    }
    if (rubyBlocks && c === "=" && atLineStart(i) && source.startsWith("=begin", i)) {
      stack.push("rublock");
      buf = "";
      commentLine = line;
      i += 5;
      continue;
    }
    if (source.startsWith("'''", i)) { stack.push("tsquote"); i += 2; continue; }
    if (source.startsWith('"""', i)) { stack.push("tdquote"); i += 2; continue; }
    if (c === "'") { stack.push("squote"); continue; }
    if (c === '"') { stack.push("dquote"); continue; }
  }

  // Unterminated comment at EOF: its content is still comment text.
  if (top() === "line" || top() === "rublock") {
    comments.push({ text: buf, line: commentLine });
  }
  return comments;
}

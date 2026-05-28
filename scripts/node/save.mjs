#!/usr/bin/env node

/**
 * Handoff Protocol - Save Script (Node.js Reference Implementation)
 *
 * Usage:
 *   node save.mjs [mode]
 *
 * Modes:
 *   (default) - Standard save
 *   compact   - Minimal summary
 *   full      - Maximum context
 *   diff      - Focus on changes
 *
 * Subcommands:
 *   node save.mjs init [direct|submodule]
 *   node save.mjs storage
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { createInterface } from "node:readline";

// ── Security ─────────────────────────────────────────────────────────────────

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
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+:[^\s"']+@[^\s"']+/gi,
  /(?:OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|GCP_KEY)\s*[:=]\s*["']?[^\s"']+["']?/gi,
  /(?:sk-[a-zA-Z0-9]{20,})/g,
];

function filterSensitive(text) {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    filtered = filtered.replace(pattern, "[REDACTED]");
  }
  return filtered;
}

// ── Command Execution ────────────────────────────────────────────────────────

function runCommand(cmd, opts) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch {
    return "";
  }
}

// ── Storage Config ───────────────────────────────────────────────────────────

function readStorageConfig(cwd) {
  const configPath = join(cwd, ".handoff.config.json");
  try {
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    if (config.storage && config.storage.mode) return config;
    return null;
  } catch {
    return null;
  }
}

function writeStorageConfig(cwd, config) {
  writeFileSync(join(cwd, ".handoff.config.json"), JSON.stringify(config, null, 2) + "\n");
}

function isSubmoduleInitialized(cwd) {
  const gitmodulesPath = join(cwd, ".gitmodules");
  if (!existsSync(gitmodulesPath)) return false;
  try {
    return readFileSync(gitmodulesPath, "utf-8").includes(".handoff");
  } catch {
    return false;
  }
}

function hasRemote(cwd) {
  return !!runCommand("git remote", { cwd });
}

function initSubmodule(cwd, remoteUrl) {
  console.log(`Adding submodule from ${remoteUrl}...`);
  const result = runCommand(`git submodule add ${remoteUrl} .handoff`, { cwd });
  if (!result && result !== "") {
    console.error("Failed to add submodule.");
    return false;
  }
  console.log("Initializing submodule...");
  runCommand("git submodule update --init --recursive .handoff", { cwd });
  return true;
}

function ensureSubmoduleReady(cwd) {
  if (isSubmoduleInitialized(cwd)) {
    runCommand("git submodule update --init --recursive .handoff", { cwd });
    return true;
  }
  console.error("Error: .handoff is not registered as a submodule.");
  console.error("Run `/handoff init submodule` first.");
  return false;
}

function commitAndPushSubmodule(handoffDir) {
  const files = ["HANDOFF.md", "context.json", "tasks.md", "decisions.md"];
  for (const file of files) {
    runCommand(`git add ${file}`, { cwd: handoffDir });
  }

  const commitResult = runCommand('git commit -m "Update handoff context"', { cwd: handoffDir });
  if (!commitResult) {
    console.log("No changes to commit in submodule (context unchanged).");
    return true;
  }

  const pushResult = runCommand("git push", { cwd: handoffDir });
  if (!pushResult) {
    console.error("Warning: Failed to push submodule. Changes are committed locally.");
    return false;
  }
  return true;
}

// ── Init Flow ────────────────────────────────────────────────────────────────

async function promptUser(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function initStorage(cwd, mode) {
  let selectedMode = mode;

  if (!selectedMode) {
    console.log("");
    console.log("Handoff storage is not configured.");
    console.log("");
    console.log("Choose where to store .handoff:");
    console.log("");
    console.log("1. direct");
    console.log("   Store .handoff/ directly in this project.");
    console.log("   Recommended for private repositories or local-only projects.");
    console.log("");
    console.log("2. submodule");
    console.log("   Store .handoff/ as a Git submodule.");
    console.log("   Recommended for public repositories where handoff context");
    console.log("   should not be exposed.");
    console.log("");

    const choice = await promptUser("Please choose: direct or submodule. > ");
    if (choice === "1" || choice === "direct") selectedMode = "direct";
    else if (choice === "2" || choice === "submodule") selectedMode = "submodule";
    else {
      console.error("Invalid choice. Please run `/handoff init direct` or `/handoff init submodule`.");
      return null;
    }
  }

  if (selectedMode === "direct") {
    mkdirSync(join(cwd, ".handoff"), { recursive: true });

    const config = {
      version: "1.1.0",
      storage: { mode: "direct", path: ".handoff" },
    };
    writeStorageConfig(cwd, config);

    if (hasRemote(cwd)) {
      console.log("");
      console.log("Warning: .handoff/ may contain private context.");
      console.log("For public repositories, consider adding .handoff/ to .gitignore");
      console.log("or use submodule mode.");
      console.log("");

      const addGitignore = await promptUser("Add .handoff/ to .gitignore? (y/n) > ");
      if (addGitignore.toLowerCase() === "y" || addGitignore.toLowerCase() === "yes") {
        const gitignorePath = join(cwd, ".gitignore");
        let existing = "";
        try { existing = readFileSync(gitignorePath, "utf-8"); } catch {}
        if (!existing.includes(".handoff")) {
          const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
          writeFileSync(gitignorePath, `${existing}${sep}.handoff\n`);
          console.log("Added .handoff/ to .gitignore");
        }
      }
    }

    console.log("Initialized direct storage mode.");
    return config;

  } else if (selectedMode === "submodule") {
    let remoteUrl = "";

    if (isSubmoduleInitialized(cwd)) {
      console.log("Submodule already registered.");
      try {
        const content = readFileSync(join(cwd, ".gitmodules"), "utf-8");
        const match = content.match(/url\s*=\s*(.+)/);
        if (match) remoteUrl = match[1].trim();
      } catch {}
    }

    if (!remoteUrl) {
      remoteUrl = await promptUser("Please provide the private handoff repository URL.\nExample: git@github.com:USER/PROJECT-handoff.git\n> ");
      if (!remoteUrl) {
        console.error("Error: Repository URL is required for submodule mode.");
        return null;
      }
    }

    if (!isSubmoduleInitialized(cwd)) {
      if (!initSubmodule(cwd, remoteUrl)) {
        console.error("Failed to initialize submodule.");
        return null;
      }
    }

    const config = {
      version: "1.1.0",
      storage: { mode: "submodule", path: ".handoff", remote: remoteUrl },
    };
    writeStorageConfig(cwd, config);

    console.log(`Initialized submodule storage mode.`);
    console.log(`Remote: ${remoteUrl}`);
    return config;
  }

  return null;
}

// ── Auto-Analysis ────────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".handoff", "dist", "build", "vendor", "__pycache__",
]);

function scanTodos(dir, maxFiles = 200) {
  const todos = [];
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s]+(.+)/gi;
  let fileCount = 0;

  function walkDir(currentDir) {
    if (++fileCount > maxFiles) return;
    let entries;
    try { entries = readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (fileCount > maxFiles) break;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walkDir(fullPath); continue; }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          let match;
          todoPattern.lastIndex = 0;
          while ((match = todoPattern.exec(lines[i])) !== null) {
            const tag = match[1].toUpperCase();
            const priority = (tag === "FIXME" || tag === "HACK") ? "high" : "medium";
            todos.push({ task: `${match[2].trim()} (${relative(dir, fullPath)}:${i + 1})`, priority, status: "pending" });
          }
        }
      } catch {}
    }
  }

  walkDir(dir);
  return todos.slice(0, 20);
}

function readProjectInfo() {
  const manifests = [
    { file: "package.json", lang: "typescript/javascript" },
    { file: "Cargo.toml", lang: "rust" },
    { file: "go.mod", lang: "go" },
    { file: "pyproject.toml", lang: "python" },
  ];
  for (const { file, lang } of manifests) {
    try {
      const content = readFileSync(file, "utf-8");
      if (file === "package.json") return { name: JSON.parse(content).name || "unknown", language: lang };
      if (file === "Cargo.toml") { const m = content.match(/name\s*=\s*"([^"]+)"/); return { name: m?.[1] || "unknown", language: lang }; }
      if (file === "go.mod") { const m = content.match(/module\s+(.+)/); return { name: m?.[1]?.split("/").pop() || "unknown", language: lang }; }
      if (file === "pyproject.toml") { const m = content.match(/name\s*=\s*"([^"]+)"/); return { name: m?.[1] || "unknown", language: lang }; }
    } catch {}
  }
  return { name: "unknown", language: "unknown" };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function save(mode) {
  const cwd = process.cwd();
  const handoffDir = join(cwd, ".handoff");

  let storageConfig = readStorageConfig(cwd);
  if (!storageConfig) {
    storageConfig = await initStorage(cwd);
    if (!storageConfig) { console.error("Error: Storage initialization failed."); process.exit(1); }
  }

  const storageMode = storageConfig.storage.mode;

  if (storageMode === "submodule") {
    if (!ensureSubmoduleReady(cwd)) process.exit(1);
  } else {
    mkdirSync(handoffDir, { recursive: true });
  }

  const { name, language } = readProjectInfo();
  const gitBranch = runCommand("git branch --show-current") || "unknown";
  const gitCommit = runCommand("git log -1 --format=%h") || "unknown";
  const gitMessage = filterSensitive(runCommand("git log -1 --format=%s") || "");
  const gitDirty = !!runCommand("git status --porcelain");
  const git = { branch: gitBranch, latest_commit: gitCommit, commit_message: gitMessage, is_dirty: gitDirty };

  const recentCommits = runCommand(`git log --oneline -n 5`) || "";
  const commits = recentCommits.split("\n").filter((l) => l.trim());
  const inferredGoal = commits[0]?.replace(/^[a-f0-9]+\s+/, "") || "";
  const completed = commits.slice(1, 6).map((c) => c.replace(/^[a-f0-9]+\s+/, ""));

  const modifiedFiles = (runCommand("git status --porcelain") || "").split("\n").filter((l) => l.trim()).map((line) => {
    const sc = line.substring(0, 2).trim();
    const p = line.substring(3).trim();
    let ct = "modified";
    if (sc === "A") ct = "added"; else if (sc === "D") ct = "deleted"; else if (sc.startsWith("R")) ct = "renamed"; else if (sc === "??") ct = "untracked";
    return { path: p, description: "", change_type: ct };
  });

  const todos = scanTodos(cwd);
  const status = modifiedFiles.length === 0 ? "idle - no pending changes" : git.is_dirty ? `in-progress - ${modifiedFiles.length} file(s) modified` : "ready - changes committed";

  const ctx = {
    version: "1.1.0", timestamp: new Date().toISOString(), agent: process.env.AGENT_NAME || "opencode",
    project: name, current_goal: inferredGoal, status, completed, modified_files: modifiedFiles,
    todos: todos.slice(0, 20), blockers: [], decisions: [], next_steps: [], git, risks: [], notes: commits.join("\n"),
  };

  const handoffMd = `# Project Handoff\n\n**Saved**: ${ctx.timestamp}\n**Agent**: ${ctx.agent}\n**Project**: ${ctx.project}\n**Branch**: ${ctx.git.branch}\n**Commit**: ${ctx.git.latest_commit} - ${ctx.git.commit_message}\n\n## Current Goal\n\n${ctx.current_goal || "No explicit goal set."}\n\n## Current Status\n\n${ctx.status}\n\n## Completed Work\n\n${completed.map((i) => `- ${i}`).join("\n") || "None"}\n\n## Modified Files\n\n${modifiedFiles.map((f) => `- \`${f.path}\` [${f.change_type}]`).join("\n") || "None"}\n\n## TODO\n\n${todos.map((t) => `- [ ] **${t.priority}** ${t.task}`).join("\n") || "None"}\n\n---\n\n*Generated by Handoff Protocol v${ctx.version}*\n`;
  const tasksMd = `# Pending Tasks\n\n## High Priority\n${todos.filter((t) => t.priority === "high").map((t) => `- [ ] ${t.task}`).join("\n") || "None"}\n\n## Medium Priority\n${todos.filter((t) => t.priority === "medium").map((t) => `- [ ] ${t.task}`).join("\n") || "None"}\n\n## Low Priority\n${todos.filter((t) => t.priority === "low").map((t) => `- [ ] ${t.task}`).join("\n") || "None"}\n`;
  const decisionsMd = "# Architecture Decisions\n\nNo decisions recorded.\n";

  writeFileSync(join(handoffDir, "HANDOFF.md"), filterSensitive(handoffMd));
  writeFileSync(join(handoffDir, "context.json"), filterSensitive(JSON.stringify(ctx, null, 2)));
  writeFileSync(join(handoffDir, "tasks.md"), filterSensitive(tasksMd));
  writeFileSync(join(handoffDir, "decisions.md"), filterSensitive(decisionsMd));

  if (storageMode === "submodule") {
    if (commitAndPushSubmodule(handoffDir)) {
      console.log("\nHandoff context has been saved and pushed to the .handoff submodule.");
      console.log("The parent repository now has an updated submodule pointer.");
      console.log("Commit it in the parent repository only if you want collaborators to use this exact handoff revision.");
    }
  }

  console.log(`\nHandoff saved to ${handoffDir}`);
  console.log(`Storage: ${storageMode}`);
  console.log(`Mode: ${mode}`);
  console.log(`Project: ${name} (${language})`);
  console.log(`Files: HANDOFF.md, context.json, tasks.md, decisions.md`);
  if (todos.length > 0) console.log(`Scanned: ${todos.length} TODO/FIXME items found`);
}

// ── Entry Point ──────────────────────────────────────────────────────────────

const arg = process.argv[2] || "save";

if (arg === "init") {
  const mode = process.argv[3];
  initStorage(process.cwd(), mode).catch(console.error);
} else if (arg === "storage") {
  const config = readStorageConfig(process.cwd());
  if (!config) { console.log("Handoff storage is not configured.\nRun `/handoff init` to set up storage."); }
  else {
    console.log("Handoff storage:");
    console.log(`  mode: ${config.storage.mode}`);
    console.log(`  path: ${config.storage.path}`);
    if (config.storage.remote) console.log(`  remote: ${config.storage.remote}`);
  }
} else {
  const validModes = ["default", "compact", "full", "diff"];
  if (!validModes.includes(arg)) { console.error(`Error: Unknown mode '${arg}'\nValid modes: ${validModes.join(", ")}`); process.exit(1); }
  save(arg).catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
}

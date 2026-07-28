// @ts-nocheck
/**
 * Handoff Protocol v2.2 — Obsidian adapter core (shared module).
 *
 * Shared, runtime-agnostic ESM module used by BOTH the Node.js implementation
 * (scripts/node/adapter.mjs) and the Deno implementation (scripts/adapter.ts).
 * It intentionally uses no runtime-specific APIs (no `Deno.*`, no `node:*`):
 * all filesystem work goes through an injected `io` adapter, so behavior stays
 * identical across runtimes and the link/unlink safety rules are testable with
 * an in-memory filesystem.
 *
 * What the adapter does
 * ---------------------
 * `/handoff adapter obsidian link --vault <path> [--alias <name>]` creates
 * `<Vault>/Projects/<alias>` as a directory symlink (macOS/Linux) or a
 * directory junction (Windows) pointing at the project's `.handoff/`, so the
 * handoff context appears inside an Obsidian Vault.
 *
 * Safety rules (exact)
 * --------------------
 * - An existing link that already points at this project's `.handoff/` is an
 *   idempotent success ("already-linked"); nothing is recreated.
 * - A real directory or file at the link path is never replaced ("collision").
 * - A link pointing anywhere else is never replaced or removed ("foreign-link").
 * - Unlink removes only a verified Adapter-created link (a symlink/junction
 *   whose target is exactly this project's `.handoff/`) and never its target.
 * - The Vault absolute path is stored only in the user-level config
 *   ($XDG_CONFIG_HOME/handoff/config.json, falling back to
 *   ~/.config/handoff/config.json on macOS/Linux; %APPDATA%/handoff/config.json
 *   on Windows). It must never be copied into the portable project config.
 *
 * Vault index
 * -----------
 * The adapter also maintains a managed index block in the Vault-root note
 * `Handoff Projects.md`, enclosed by the markers
 * `<!-- handoff-projects:start -->` / `<!-- handoff-projects:end -->`. The
 * block holds sorted wikilinks to each linked project's `context-map.md`.
 * Content outside the markers is user-authored and never touched; when the
 * markers are missing from an existing note, the block is appended. The
 * sensitive-data filter runs on the managed block content before every write.
 *
 * io seam
 * -------
 *   lstat(path)      -> { kind: "directory" | "file" | "symlink" | "other" } | null
 *   exists(path)     -> boolean (follows links; used for broken-link detection)
 *   readlink(path)   -> string
 *   symlink(target, linkPath, { junction }) -> void (throws on failure)
 *   mkdir(path)      -> void (recursive)
 *   unlink(path)     -> void (removes the link itself, never its target)
 *   readFile(path)   -> string | null (null when the file does not exist)
 *   writeFile(path, content) -> void
 */

import { filterSensitive } from "../context-map.mjs";

// ── Path validation ──────────────────────────────────────────────────────────

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC = /^[\\/]{2}/;

function isAbsolutePath(value) {
  return value.startsWith("/") || WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value);
}

function hasParentTraversal(value) {
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * Validate an Obsidian Vault path. The Vault path is machine-specific and
 * therefore MUST be absolute; relative and home-relative paths are rejected.
 * Spaces and Unicode are explicitly allowed.
 *
 * @param {unknown} vaultPath
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateVaultPath(vaultPath) {
  const errors = [];
  if (typeof vaultPath !== "string" || !vaultPath.trim()) {
    errors.push("vault path: must be a non-empty absolute path string");
    return { valid: false, errors };
  }
  if (!isAbsolutePath(vaultPath)) {
    errors.push(`vault path: must be an absolute path (got "${vaultPath}")`);
  }
  if (hasParentTraversal(vaultPath)) {
    errors.push('vault path: parent traversal ("..") is not allowed');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a project alias used as the directory name under `<Vault>/Projects/`.
 *
 * @param {unknown} alias
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAlias(alias) {
  const errors = [];
  if (typeof alias !== "string" || !alias.trim()) {
    errors.push("alias: must be a non-empty string");
    return { valid: false, errors };
  }
  if (alias === "." || alias === ".." || /[\\/]/.test(alias)) {
    errors.push(`alias: must be a plain directory name, not a path (got "${alias}")`);
  }
  // Newlines inject extra lines into the managed index block; `]`, `|`,
  // `#`, `^` break or repurpose the wikilink entry; control characters
  // corrupt the Vault note.
  if (/[\r\n\]|[#^\u0000-\u001f\u007f]/.test(alias)) {
    errors.push("alias: must not contain newlines, control characters, or wikilink syntax characters ( ] | # ^ )");
  }
  return { valid: errors.length === 0, errors };
}

// ── User-level config location ───────────────────────────────────────────────

/**
 * Resolve the user-level handoff config path for the current user.
 *
 * @param {Record<string, string | undefined>} env  Relevant environment variables.
 * @param {string} platform  Node-style platform ("win32", "darwin", "linux", ...).
 * @returns {string | null} The config path, or null when it cannot be resolved.
 */
export function userConfigPath(env, platform) {
  if (platform === "win32") {
    const appData = env.APPDATA;
    return appData ? `${appData}\\handoff\\config.json` : null;
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return `${trimTrailingSeparators(xdg)}/handoff/config.json`;
  const home = env.HOME;
  if (home) return `${trimTrailingSeparators(home)}/.config/handoff/config.json`;
  return null;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function trimTrailingSeparators(p) {
  return p.replace(/[\\/]+$/, "");
}

function separatorOf(p) {
  return p.includes("\\") && !p.startsWith("/") ? "\\" : "/";
}

function joinPath(base, segment) {
  return `${trimTrailingSeparators(base)}${separatorOf(base)}${segment}`;
}

/** The link location for a project inside a Vault: `<Vault>/Projects/<alias>`. */
export function linkPathFor(vaultPath, alias) {
  return joinPath(joinPath(vaultPath, "Projects"), alias);
}

/**
 * Resolve the alias for a project: explicit `--alias` flag wins, then the
 * portable project config's `adapters.obsidian.projectAlias`, then the
 * project directory's basename.
 */
export function resolveAlias({ alias, projectAlias, projectDir }) {
  if (alias && String(alias).trim()) return String(alias).trim();
  if (projectAlias && String(projectAlias).trim()) return String(projectAlias).trim();
  const trimmed = trimTrailingSeparators(String(projectDir));
  return trimmed.split(/[\\/]/).pop();
}

// Target comparison normalizes separator style and trailing separators so a
// junction read back on Windows still matches its creation target.
function normalizeTarget(p) {
  return trimTrailingSeparators(String(p)).replace(/\\/g, "/");
}

function sameTarget(a, b) {
  return normalizeTarget(a) === normalizeTarget(b);
}

// ── Result constructors ──────────────────────────────────────────────────────

function ok(state, linkPath, target, extra = {}) {
  return { ok: true, state, linkPath, target, ...extra };
}

function fail(reason, message, linkPath, target, extra = {}) {
  return { ok: false, reason, message, linkPath, target, ...extra };
}

function permissionGuidance(platform) {
  if (platform === "win32") {
    return "Windows refused to create the directory link. Enable Developer Mode (Settings > Privacy & security > For developers) or run this command from an elevated (administrator) terminal, then retry.";
  }
  return "The operating system refused to create the link. Check that the Vault directory is writable by your user; on macOS, if the Vault lives under Documents/Desktop/Downloads, grant your terminal Full Disk Access (System Settings > Privacy & Security > Full Disk Access), then retry.";
}

// ── Vault index ──────────────────────────────────────────────────────────────

/** The Vault-root note holding the managed index block. */
export const INDEX_FILENAME = "Handoff Projects.md";
export const INDEX_START = "<!-- handoff-projects:start -->";
export const INDEX_END = "<!-- handoff-projects:end -->";

/** The index note location: `<Vault>/Handoff Projects.md`. */
export function indexPathFor(vaultPath) {
  return joinPath(vaultPath, INDEX_FILENAME);
}

/** The managed index entry for an alias: a wikilink to its context-map.md. */
export function indexEntryFor(alias) {
  return `- [[Projects/${alias}/context-map]]`;
}

/**
 * Add or remove one entry in the managed index block, leaving all content
 * outside the markers untouched. Creates the note when missing; appends the
 * block when an existing note has no markers. Entries are deduplicated and
 * sorted. The sensitive-data filter runs on the managed block content before
 * the note is written; user content outside the markers is never rewritten.
 */
async function updateVaultIndex(io, vaultPath, alias, { add }) {
  const indexPath = indexPathFor(vaultPath);
  const entry = filterSensitive(indexEntryFor(alias));
  const existing = await io.readFile(indexPath);
  if (existing === null && !add) return; // nothing to remove; don't create the note
  const eol = existing && existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing === null ? [] : existing.split(/\r?\n/);

  const start = lines.findIndex((l) => l.trim() === INDEX_START);
  const end = lines.findIndex((l) => l.trim() === INDEX_END);

  let next;
  if (start === -1 || end === -1 || end < start) {
    // No managed block: append one at the end, preserving user content.
    next = [...lines];
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push(INDEX_START);
    if (add) next.push(entry);
    next.push(INDEX_END);
    next.push("");
  } else {
    const entries = new Set(
      lines
        .slice(start + 1, end)
        .filter((l) => l.trim() !== "")
        .map((l) => filterSensitive(l))
    );
    if (add) entries.add(entry);
    else entries.delete(entry);
    next = [...lines.slice(0, start + 1), ...[...entries].sort(), ...lines.slice(end)];
  }

  const content = next.join(eol);
  if (content === existing) return;
  await io.writeFile(indexPath, content);
}

// ── Link ─────────────────────────────────────────────────────────────────────

/**
 * Create `<Vault>/Projects/<alias>` -> `<projectDir>/.handoff`.
 *
 * Idempotent: an existing link to the same target is a success. Refuses to
 * replace real directories/files ("collision") or foreign links
 * ("foreign-link").
 */
export async function obsidianLink({ vaultPath, alias, projectDir, platform }, io) {
  const target = joinPath(projectDir, ".handoff");

  const pathCheck = validateVaultPath(vaultPath);
  if (!pathCheck.valid) {
    return fail("invalid-vault", `Invalid Vault path: ${pathCheck.errors.join("; ")}`, null, target);
  }
  const aliasCheck = validateAlias(alias);
  if (!aliasCheck.valid) {
    return fail("invalid-alias", `Invalid alias: ${aliasCheck.errors.join("; ")}`, null, target);
  }

  const linkPath = linkPathFor(vaultPath, alias);

  const vaultStat = await io.lstat(vaultPath);
  if (!vaultStat || vaultStat.kind !== "directory") {
    return fail(
      "vault-missing",
      `Vault directory not found: ${vaultPath}\nCreate the Vault in Obsidian first, or pass the correct --vault path.`,
      linkPath,
      target
    );
  }

  const existing = await io.lstat(linkPath);
  if (existing) {
    if (existing.kind === "symlink") {
      const actual = await io.readlink(linkPath);
      if (sameTarget(actual, target)) {
        await updateVaultIndex(io, vaultPath, alias, { add: true });
        return ok("already-linked", linkPath, target);
      }
      return fail(
        "foreign-link",
        `Refusing to replace an existing link that points elsewhere:\n  ${linkPath} -> ${actual}\nRemove it yourself if it is no longer needed.`,
        linkPath,
        target,
        { actualTarget: actual }
      );
    }
    return fail(
      "collision",
      `Refusing to replace an existing ${existing.kind} (user data):\n  ${linkPath}\nChoose a different --alias or move that ${existing.kind} yourself.`,
      linkPath,
      target
    );
  }

  await io.mkdir(joinPath(vaultPath, "Projects"));
  try {
    await io.symlink(target, linkPath, { junction: platform === "win32" });
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES" || err.name === "PermissionDenied" || /denied|permitted/i.test(err.message || ""))) {
      return fail("permission-denied", `Could not create the link: ${err.message}`, linkPath, target, {
        guidance: permissionGuidance(platform),
      });
    }
    return fail("error", `Could not create the link: ${err.message || err}`, linkPath, target);
  }
  await updateVaultIndex(io, vaultPath, alias, { add: true });
  return ok("linked", linkPath, target);
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * Report the adapter state for a project: linked, missing, broken (link
 * target gone), foreign-link, or conflict (real directory/file at the path).
 */
export async function obsidianStatus({ vaultPath, alias, projectDir, platform }, io) {
  const target = joinPath(projectDir, ".handoff");
  const linkPath = linkPathFor(vaultPath, alias);
  const base = { vaultPath, alias, linkPath, target };

  const stat = await io.lstat(linkPath);
  if (!stat) return { ...base, state: "missing" };
  if (stat.kind !== "symlink") return { ...base, state: "conflict", kind: stat.kind };

  const actual = await io.readlink(linkPath);
  if (!sameTarget(actual, target)) return { ...base, state: "foreign-link", actualTarget: actual };
  if (!(await io.exists(target))) return { ...base, state: "broken", actualTarget: actual };
  return { ...base, state: "linked", actualTarget: actual };
}

// ── Unlink ───────────────────────────────────────────────────────────────────

/**
 * Remove the Adapter-created link. Only a symlink/junction whose target is
 * exactly this project's `.handoff/` is removed; real directories, files, and
 * foreign links are refused. The link's target is never touched.
 */
export async function obsidianUnlink({ vaultPath, alias, projectDir, platform }, io) {
  const target = joinPath(projectDir, ".handoff");
  const linkPath = linkPathFor(vaultPath, alias);

  const stat = await io.lstat(linkPath);
  if (!stat) {
    await updateVaultIndex(io, vaultPath, alias, { add: false });
    return ok("not-linked", linkPath, target);
  }
  if (stat.kind !== "symlink") {
    return fail(
      "collision",
      `Refusing to remove an existing ${stat.kind} (user data):\n  ${linkPath}\nThe adapter only removes links it created.`,
      linkPath,
      target
    );
  }
  const actual = await io.readlink(linkPath);
  if (!sameTarget(actual, target)) {
    return fail(
      "foreign-link",
      `Refusing to remove a link that points elsewhere:\n  ${linkPath} -> ${actual}\nThe adapter only removes links it created.`,
      linkPath,
      target,
      { actualTarget: actual }
    );
  }
  await io.unlink(linkPath);
  await updateVaultIndex(io, vaultPath, alias, { add: false });
  return ok("unlinked", linkPath, target);
}

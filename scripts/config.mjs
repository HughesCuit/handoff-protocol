/**
 * Handoff Protocol v1.5.1 — project configuration policy (shared module).
 *
 * Runtime-agnostic ESM: no `node:*` or `Deno.*` imports. Consumed by the Node
 * scripts (scripts/node/*.mjs), the Deno scripts (scripts/*.ts), and the
 * shared test suite (tests/shared/unit-suite.mjs).
 *
 * `.handoff.config.json` is portable project configuration: it may be
 * committed and shared across machines and agents, so it must never contain
 * absolute paths, home-relative paths, Vault paths, or credential-like
 * values. The single exception is `storage.remote`, whose existing submodule
 * URL behavior (SSH/HTTPS git URLs, including credential-embedded URLs a user
 * may already rely on) remains supported.
 */

import { filterSensitive } from "./context-map.mjs";

export const CONFIG_FILENAME = ".handoff.config.json";

export const STORAGE_MODES = ["direct", "submodule"];

// ── Path classification ──────────────────────────────────────────────────────

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC = /^[\\/]{2}/;
const HOME_ENV = /^(\$(HOME|\{HOME\})|%(USERPROFILE|HOME)%)[\\/]/i;

function isAbsolutePath(value) {
  return value.startsWith("/") || WINDOWS_DRIVE.test(value) || WINDOWS_UNC.test(value);
}

function isHomePath(value) {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\") || HOME_ENV.test(value);
}

function hasParentTraversal(value) {
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

// ── Portability scan ─────────────────────────────────────────────────────────

// storage.remote is the only exempt field: submodule remote URLs keep their
// existing behavior and are not scanned for path or credential patterns.
const EXEMPT_PATHS = new Set(["storage.remote"]);

function checkPortableString(value, path, errors) {
  if (isAbsolutePath(value)) {
    errors.push(`${path}: absolute paths are not portable; keep .handoff.config.json machine-independent`);
  } else if (isHomePath(value)) {
    errors.push(`${path}: home-relative paths (~, $HOME, %USERPROFILE%) are not portable; keep .handoff.config.json machine-independent`);
  } else if (hasParentTraversal(value)) {
    errors.push(`${path}: parent traversal ("..") points outside the project and is not portable`);
  }
  if (filterSensitive(value) !== value) {
    errors.push(`${path}: sensitive or credential-like values must never be stored in .handoff.config.json`);
  }
}

function scanForNonPortableValues(value, path, errors) {
  if (typeof value === "string") {
    checkPortableString(value, path, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForNonPortableValues(item, `${path}[${i}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (EXEMPT_PATHS.has(childPath)) continue;
      scanForNonPortableValues(child, childPath, errors);
    }
  }
}

// ── Public interface ─────────────────────────────────────────────────────────

/**
 * Validate a parsed `.handoff.config.json`.
 *
 * @param {unknown} config Parsed JSON value (any type is accepted for checking).
 * @returns {{ valid: boolean, errors: string[], config: unknown }}
 *   `valid` is true when `errors` is empty; `config` echoes the input.
 */
export function validateProjectConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { valid: false, errors: ["config: must be a JSON object"], config };
  }

  if (config.version !== undefined && (typeof config.version !== "string" || !config.version.trim())) {
    errors.push("version: must be a non-empty string");
  }

  const storage = config.storage;
  if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
    errors.push('storage: must be an object with a mode of "direct" or "submodule"');
  } else {
    if (typeof storage.mode !== "string" || !STORAGE_MODES.includes(storage.mode)) {
      const got = typeof storage.mode === "string" ? ` (got "${storage.mode}")` : "";
      errors.push(`storage.mode: must be one of ${STORAGE_MODES.map((m) => `"${m}"`).join(", ")}${got}`);
    }
    if (typeof storage.path !== "string" || !storage.path.trim()) {
      errors.push("storage.path: must be a non-empty relative path string");
    }
    if (storage.remote !== undefined && typeof storage.remote !== "string") {
      errors.push("storage.remote: must be a string");
    }
  }

  scanForNonPortableValues(config, "", errors);

  return { valid: errors.length === 0, errors, config };
}

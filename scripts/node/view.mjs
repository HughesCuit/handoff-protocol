#!/usr/bin/env node

import { spawn as realSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DAEMON_VERSION,
  acquireStartupLock,
  getRuntimeDir,
  healthCheck,
  isStaleLock,
  readLock,
  readState,
  releaseStartupLock,
  removeState,
} from "../../viewer/runtime/daemon-state.mjs";
import { parseRenderTree, ContextMapParseError } from "../../viewer/runtime/context-map-parser.mjs";
import { readContextMapSource, resolveContextMap } from "../../viewer/runtime/context-source.mjs";

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const DEFAULT_IDLE_MINUTES = 30;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 1440;

const DAEMON_MAIN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../viewer/runtime/daemon-main.mjs",
);

const CORRECTIONS = {
  VIEW_REQUIRES_NODE: "Run this command with Node.js: node scripts/node/view.mjs",
  VIEW_INVALID_IDLE_MINUTES: "Use an integer between 1 and 1440.",
  VIEW_PROJECT_INACCESSIBLE: "Run from a readable project directory containing .handoff/.",
  VIEW_CONTEXT_MISSING: "Run /handoff save first to create .handoff/context-map.md.",
  VIEW_CONTEXT_INVALID: "Inspect .handoff/context-map.md and fix its structure.",
  VIEW_CONTEXT_TOO_LARGE: "Reduce .handoff/context-map.md below 2 MiB.",
  VIEW_STATE_UNSAFE: "The Handoff daemon runtime directory has unsafe ownership or permissions.",
  VIEW_DAEMON_START_TIMEOUT: "The Viewer daemon did not become ready in time.",
  VIEW_DAEMON_VERSION_CONFLICT: "An incompatible Viewer daemon is already running.",
  VIEW_SESSION_CREATE_FAILED: "The Viewer daemon could not create a session.",
};

export class ViewError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ViewError";
    this.code = code;
  }
}

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(argv) {
  let idleMinutes = DEFAULT_IDLE_MINUTES;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--idle-minutes") {
      const value = argv[index + 1];
      index += 1;
      idleMinutes = parseIdleMinutes(value);
      continue;
    }
    if (arg.startsWith("--idle-minutes=")) {
      idleMinutes = parseIdleMinutes(arg.slice("--idle-minutes=".length));
      continue;
    }
    throw new ViewError("VIEW_INVALID_IDLE_MINUTES", `unknown argument "${arg}"`);
  }
  return { idleMinutes, json };
}

function parseIdleMinutes(value) {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < MIN_IDLE_MINUTES || parsed > MAX_IDLE_MINUTES) {
    throw new ViewError("VIEW_INVALID_IDLE_MINUTES");
  }
  return parsed;
}

async function validateProjectRoot(cwd, deps) {
  const resolveSource = deps.resolveSource ?? resolveContextMap;
  const readSource = deps.readSource ?? readContextMapSource;
  const parse = deps.parse ?? parseRenderTree;
  if (!isAbsolute(cwd)) throw new ViewError("VIEW_PROJECT_INACCESSIBLE", "project root must be absolute");
  let source;
  try {
    source = await resolveSource(pathToFileURL(resolve(cwd)).href);
  } catch {
    throw new ViewError("VIEW_PROJECT_INACCESSIBLE");
  }
  let content;
  try {
    content = await readSource(source);
  } catch (error) {
    const code = error?.code;
    if (code === "MISSING") throw new ViewError("VIEW_CONTEXT_MISSING");
    if (code === "TOO_LARGE") throw new ViewError("VIEW_CONTEXT_TOO_LARGE");
    throw new ViewError("VIEW_PROJECT_INACCESSIBLE");
  }
  try {
    parse(content);
  } catch (error) {
    if (error instanceof ContextMapParseError) throw new ViewError("VIEW_CONTEXT_INVALID");
    throw error;
  }
  return source.rootPath;
}

async function requestShutdown(state, fetchImpl) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${state.port}/control/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.controlToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function pollForHealthyState(runtimeDir, deps, timeoutMs) {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const state = await readState(runtimeDir, deps.fsApi);
    if (state && state.daemonVersion === DAEMON_VERSION && (await healthCheck(state, { fetch: deps.fetch }))) {
      return state;
    }
    if (deps.now() >= deadline) throw new ViewError("VIEW_DAEMON_START_TIMEOUT");
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

async function spawnDaemon(deps) {
  const child = deps.spawn(deps.execPath, [deps.daemonMainPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return child;
}

async function startDaemonCoordinated(runtimeDir, deps) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const gotLock = await acquireStartupLock(runtimeDir, {
      fsApi: deps.fsApi,
      now: deps.now,
    });
    if (gotLock) {
      try {
        await spawnDaemon(deps);
        return await pollForHealthyState(runtimeDir, deps, STARTUP_TIMEOUT_MS);
      } finally {
        await releaseStartupLock(runtimeDir, deps.fsApi);
      }
    }
    const existingState = await readState(runtimeDir, deps.fsApi);
    if (existingState && existingState.daemonVersion === DAEMON_VERSION && (await healthCheck(existingState, { fetch: deps.fetch }))) {
      return existingState;
    }
    const lock = await readLock(runtimeDir, { fsApi: deps.fsApi, now: deps.now });
    if (isStaleLock(lock, { daemonHealthy: false })) {
      await releaseStartupLock(runtimeDir, deps.fsApi);
      continue;
    }
    // A live starter holds the lock; wait for it to publish a healthy state.
    return pollForHealthyState(runtimeDir, deps, STARTUP_TIMEOUT_MS);
  }
  throw new ViewError("VIEW_DAEMON_START_TIMEOUT");
}

async function ensureDaemon(deps) {
  const runtimeDir = deps.runtimeDir;
  const existing = await readState(runtimeDir, deps.fsApi);
  if (existing) {
    const healthy = await healthCheck(existing, { fetch: deps.fetch });
    if (healthy && existing.daemonVersion === DAEMON_VERSION) {
      return { state: existing, reused: true };
    }
    if (healthy && existing.daemonVersion !== DAEMON_VERSION) {
      // Incompatible daemon: request authenticated graceful shutdown, then replace.
      if (!(await requestShutdown(existing, deps.fetch))) {
        throw new ViewError("VIEW_DAEMON_VERSION_CONFLICT");
      }
      const deadline = deps.now() + SHUTDOWN_TIMEOUT_MS;
      while ((await healthCheck(existing, { fetch: deps.fetch })) && deps.now() < deadline) {
        await deps.sleep(POLL_INTERVAL_MS);
      }
      // Post-deadline re-check: if the old daemon is still healthy, shutdown failed.
      if (await healthCheck(existing, { fetch: deps.fetch })) {
        throw new ViewError("VIEW_DAEMON_VERSION_CONFLICT");
      }
      await removeState(runtimeDir, deps.fsApi);
      return { state: await startDaemonCoordinated(runtimeDir, deps), reused: false };
    }
    // Stale record (dead or unreachable daemon): remove and restart.
    await removeState(runtimeDir, deps.fsApi);
  }
  return { state: await startDaemonCoordinated(runtimeDir, deps), reused: false };
}

async function createViewerSession(state, { workspaceRoot, idleMinutes, fetch: fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${state.port}/control/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.controlToken}` },
      body: JSON.stringify({ workspaceRoot, idleMinutes }),
    });
  } catch {
    throw new ViewError("VIEW_SESSION_CREATE_FAILED");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ViewError(typeof body.error === "string" ? body.error : "VIEW_SESSION_CREATE_FAILED");
  }
  return response.json();
}

function formatHuman(result) {
  return `Context Map Viewer ready.\nURL: ${result.url}\nExpires after: ${result.idleMinutes} minutes idle\n`;
}

function formatJson(result, reused) {
  return `${JSON.stringify({
    status: "ready",
    url: result.url,
    sessionId: result.sessionId,
    source: result.source,
    idleMinutes: result.idleMinutes,
    daemonReused: reused,
  })}\n`;
}

export async function runView(options = {}) {
  const argv = options.argv ?? [];
  const cwd = options.cwd ?? process.cwd();
  const deps = {
    fetch: options.fetch ?? globalThis.fetch,
    spawn: options.spawn ?? realSpawn,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? realSleep,
    fsApi: options.fsApi,
    execPath: options.execPath ?? process.execPath,
    daemonMainPath: options.daemonMainPath ?? DAEMON_MAIN_PATH,
    resolveSource: options.resolveSource,
    readSource: options.readSource,
    parse: options.parse,
  };

  try {
    const { idleMinutes, json } = parseArgs(argv);
    const workspaceRoot = await validateProjectRoot(cwd, deps);
    const runtimeDir = options.runtimeDir ?? (await getRuntimeDir({
      fsApi: deps.fsApi,
      tmpdir: options.tmpdir,
      uid: options.uid,
      platform: options.platform,
      xdgRuntimeDir: options.xdgRuntimeDir,
    }));
    deps.runtimeDir = runtimeDir;
    const { state, reused } = await ensureDaemon(deps);
    const session = await createViewerSession(state, { workspaceRoot, idleMinutes, fetch: deps.fetch });
    return { ok: true, json, output: json ? formatJson(session, reused) : formatHuman(session) };
  } catch (error) {
    const json = argv.includes("--json");
    if (error instanceof ViewError) {
      return { ok: false, json, error: { code: error.code, correction: CORRECTIONS[error.code] ?? "" } };
    }
    // Map runtime errors carrying a known VIEW_ code (e.g. DaemonStateError: VIEW_STATE_UNSAFE).
    const code = error && typeof error.code === "string" ? error.code : null;
    if (code && Object.prototype.hasOwnProperty.call(CORRECTIONS, code)) {
      return { ok: false, json, error: { code, correction: CORRECTIONS[code] } };
    }
    // Unexpected error: report safely without leaking internals or absolute paths.
    return { ok: false, json, error: { code: "VIEW_SESSION_CREATE_FAILED", correction: CORRECTIONS.VIEW_SESSION_CREATE_FAILED } };
  }
}

async function main() {
  const result = await runView({ argv: process.argv.slice(2), cwd: process.cwd() });
  if (result.ok) {
    process.stdout.write(result.output);
    return;
  }
  if (result.json) {
    process.stdout.write(`${JSON.stringify({ status: "error", error: result.error.code })}\n`);
    process.stderr.write(`${CORRECTIONS[result.error.code] ?? result.error.code}\n`);
  } else {
    process.stderr.write(`${result.error.code}\n${result.error.correction}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

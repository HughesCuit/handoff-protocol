import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;
export const DAEMON_VERSION = "2.4.0";
export const STATE_FILENAME = "daemon.json";
export const LOCK_FILENAME = "daemon.lock";
export const DEFAULT_MAX_LOCK_AGE_MS = 30_000;
export const HEALTH_TIMEOUT_MS = 2_000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_OWNER_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export class DaemonStateError extends Error {
  constructor(code) {
    super(code);
    this.name = "DaemonStateError";
    this.code = code;
  }
}

const defaultFs = {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
};

function resolveUid(options) {
  if (options.uid !== undefined) return options.uid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function resolveUsername(options) {
  if (options.username !== undefined) return options.username;
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}

function validateDirOwnership(info, expectedUid) {
  if (expectedUid !== null && info.uid !== expectedUid) {
    throw new DaemonStateError("VIEW_STATE_UNSAFE");
  }
}

function validateDirMode(info) {
  if ((info.mode & 0o077) !== 0) {
    throw new DaemonStateError("VIEW_STATE_UNSAFE");
  }
}

async function ensureSafeDir(dir, fsApi, expectedUid) {
  let info;
  try {
    info = await fsApi.lstat(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new DaemonStateError("VIEW_STATE_UNSAFE");
    await fsApi.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fsApi.chmod(dir, DIR_MODE);
    info = await fsApi.stat(dir);
    validateDirOwnership(info, expectedUid);
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DaemonStateError("VIEW_STATE_UNSAFE");
  }
  validateDirOwnership(info, expectedUid);
  validateDirMode(info);
}

export async function getRuntimeDir(options = {}) {
  const fsApi = options.fsApi ?? defaultFs;
  const baseTmp = options.tmpdir ?? tmpdir();
  const platform = options.platform ?? process.platform;
  const uid = resolveUid(options);
  const xdgRuntimeDir = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;

  let dir;
  if (platform === "linux" && xdgRuntimeDir) {
    dir = join(xdgRuntimeDir, "handoff");
  } else {
    const suffix = uid !== null ? String(uid) : resolveUsername(options);
    dir = join(baseTmp, `handoff-${suffix}`);
  }

  await ensureSafeDir(dir, fsApi, uid);
  return dir;
}

export function isValidState(state) {
  return state !== null &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    state.schemaVersion === SCHEMA_VERSION &&
    typeof state.daemonVersion === "string" &&
    Number.isInteger(state.pid) &&
    Number.isInteger(state.port) &&
    typeof state.controlToken === "string" &&
    state.controlToken.length > 0 &&
    typeof state.startedAt === "string";
}

export function createStateRecord({ pid, port, controlToken, now = Date.now }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    daemonVersion: DAEMON_VERSION,
    pid,
    port,
    controlToken,
    startedAt: new Date(now()).toISOString(),
  };
}

export async function writeState(runtimeDir, state, fsApi = defaultFs) {
  const target = join(runtimeDir, STATE_FILENAME);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsApi.writeFile(temp, JSON.stringify(state, null, 2), { mode: FILE_MODE });
  await fsApi.chmod(temp, FILE_MODE);
  await fsApi.rename(temp, target);
}

export async function readState(runtimeDir, fsApi = defaultFs) {
  let raw;
  try {
    raw = await fsApi.readFile(join(runtimeDir, STATE_FILENAME), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function removeState(runtimeDir, fsApi = defaultFs) {
  await fsApi.rm(join(runtimeDir, STATE_FILENAME), { force: true });
}

export async function acquireStartupLock(runtimeDir, options = {}) {
  const fsApi = options.fsApi ?? defaultFs;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const ownerId = options.ownerId ?? randomBytes(24).toString("base64url");
  if (!LOCK_OWNER_PATTERN.test(ownerId)) throw new DaemonStateError("VIEW_STATE_UNSAFE");
  const target = join(runtimeDir, LOCK_FILENAME);
  try {
    await fsApi.mkdir(target, { mode: DIR_MODE });
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    const payload = JSON.stringify({
      pid,
      ownerId,
      lockedAt: now(),
      startedAt: new Date(now()).toISOString(),
    });
    await fsApi.writeFile(join(target, `${ownerId}.json`), payload, { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    await fsApi.rm(target, { recursive: true, force: true });
    throw error;
  }
  return ownerId;
}

export async function readLock(runtimeDir, options = {}) {
  const fsApi = options.fsApi ?? defaultFs;
  const now = options.now ?? Date.now;
  const target = join(runtimeDir, LOCK_FILENAME);
  let info;
  try {
    info = await fsApi.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory()) {
    return {
      pid: null,
      ownerId: null,
      lockedAt: info.mtimeMs,
      startedAt: null,
      ageMs: now() - info.mtimeMs,
      legacy: true,
    };
  }
  const entries = await fsApi.readdir(target);
  const markers = entries.filter((entry) => LOCK_OWNER_PATTERN.test(entry.slice(0, -5)) && entry.endsWith(".json"));
  if (markers.length !== 1) {
    return {
      pid: null,
      ownerId: null,
      lockedAt: info.mtimeMs,
      startedAt: null,
      ageMs: now() - info.mtimeMs,
      empty: entries.length === 0,
    };
  }
  let raw;
  try {
    raw = await fsApi.readFile(join(target, markers[0]), "utf8");
    const parsed = JSON.parse(raw);
    if (!Number.isInteger(parsed.pid) || !Number.isInteger(parsed.lockedAt) ||
      typeof parsed.ownerId !== "string" || parsed.ownerId !== markers[0].slice(0, -5)) {
      return {
        pid: null,
        ownerId: markers[0].slice(0, -5),
        lockedAt: info.mtimeMs,
        startedAt: null,
        ageMs: now() - info.mtimeMs,
        malformed: true,
      };
    }
    return {
      pid: parsed.pid,
      ownerId: parsed.ownerId,
      lockedAt: parsed.lockedAt,
      startedAt: parsed.startedAt,
      ageMs: now() - parsed.lockedAt,
    };
  } catch {
    return {
      pid: null,
      ownerId: markers[0].slice(0, -5),
      lockedAt: info.mtimeMs,
      startedAt: null,
      ageMs: now() - info.mtimeMs,
      malformed: true,
    };
  }
}

export async function releaseStartupLock(runtimeDir, ownerId, fsApi = defaultFs) {
  const target = join(runtimeDir, LOCK_FILENAME);
  if (ownerId === null) {
    try {
      await fsApi.rmdir(target);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
      throw error;
    }
  }
  if (typeof ownerId !== "string" || !LOCK_OWNER_PATTERN.test(ownerId)) return false;
  try {
    await fsApi.rm(join(target, `${ownerId}.json`));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    await fsApi.rmdir(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
    throw error;
  }
}

export async function recoverStaleStartupLock(runtimeDir, lock, fsApi = defaultFs) {
  if (!lock || lock.legacy) return false;
  if (lock.empty) return releaseStartupLock(runtimeDir, null, fsApi);
  if (typeof lock.ownerId === "string") return releaseStartupLock(runtimeDir, lock.ownerId, fsApi);
  return false;
}

export function isStaleLock(lock, { maxLockAgeMs = DEFAULT_MAX_LOCK_AGE_MS, daemonHealthy = false } = {}) {
  if (!lock) return false;
  return lock.ageMs >= maxLockAgeMs && !daemonHealthy;
}

export async function healthCheck(state, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  if (!isValidState(state)) return false;
  const url = `http://127.0.0.1:${state.port}/control/health`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${state.controlToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return body !== null &&
    typeof body === "object" &&
    body.pid === state.pid &&
    body.schemaVersion === state.schemaVersion &&
    body.daemonVersion === state.daemonVersion;
}

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  getRuntimeDir,
  createStateRecord,
  releaseStartupLock,
  removeState,
  writeState,
} from "./daemon-state.mjs";
import { DaemonServer } from "./daemon-server.mjs";
import { SessionManager } from "./session-manager.mjs";

const DEFAULT_IDLE_CHECK_MS = 10_000;

async function defaultLoadAssets() {
  const base = new URL("../dist/", import.meta.url);
  const [html, app, model, styles] = await Promise.all([
    readFile(new URL("index.html", base), "utf8"),
    readFile(new URL("app.mjs", base), "utf8"),
    readFile(new URL("model.mjs", base), "utf8"),
    readFile(new URL("styles.css", base), "utf8"),
  ]);
  return { html, app, model, styles };
}

export async function startDaemon(options = {}) {
  const runtimeDir = options.runtimeDir ?? (await getRuntimeDir());
  const loadAssets = options.loadAssets ?? defaultLoadAssets;
  const assets = await loadAssets();
  const sessionManager = options.sessionManager ?? new SessionManager();
  const controlToken = options.controlToken ?? randomBytes(32).toString("base64url");
  const processObject = options.processObject ?? process;
  const idleCheckMs = options.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS;

  let closePromise = null;
  let idleTimer = null;
  const signalHandlers = new Map();

  const server = new DaemonServer({
    sessionManager,
    assets,
    controlToken,
    pid: processObject.pid,
    onShutdownRequest: () => close(),
  });

  const { port } = await server.start();
  const state = createStateRecord({ pid: processObject.pid, port, controlToken });
  await writeState(runtimeDir, state);

  function removeSignalHandlers() {
    for (const [signal, handler] of signalHandlers) processObject.off(signal, handler);
    signalHandlers.clear();
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      removeSignalHandlers();
      await server.close();
      await removeState(runtimeDir);
      await releaseStartupLock(runtimeDir);
    })();
    return closePromise;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      void close();
    };
    signalHandlers.set(signal, handler);
    processObject.once(signal, handler);
  }

  idleTimer = setInterval(() => {
    if (!sessionManager.hasSessions) void close();
  }, idleCheckMs);
  idleTimer.unref?.();

  return { close, port, controlToken, state, runtimeDir };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await startDaemon();
}

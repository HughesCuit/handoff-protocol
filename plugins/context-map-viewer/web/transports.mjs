function unwrapToolResult(result) {
  return result?.structuredContent ??
    result?.content?.structuredContent ??
    result?.result?.structuredContent ??
    null;
}

export function createMcpTransport({ parentWindow, windowObject, onSnapshot = () => {} }) {
  const pending = new Map();
  let requestId = 1;
  let disposed = false;

  function request(method, params) {
    if (disposed) return Promise.reject(new Error("MCP_TRANSPORT_DISPOSED"));
    const id = requestId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    parentWindow.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return result;
  }

  async function read(bindingId) {
    return unwrapToolResult(await request("tools/call", {
      name: "get_context_map",
      arguments: { bindingId },
    }));
  }

  function handleMessage(event) {
    if (event.source !== parentWindow) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(message.error);
      else handler.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") {
      const snapshot = unwrapToolResult(message.params);
      if (snapshot) onSnapshot(snapshot);
    }
  }

  windowObject.addEventListener("message", handleMessage);
  return {
    initialSnapshot() {
      return windowObject.openai?.toolOutput ?? read();
    },
    refresh: read,
    dispose() {
      if (disposed) return;
      disposed = true;
      windowObject.removeEventListener("message", handleMessage);
      for (const { reject } of pending.values()) reject(new Error("MCP_TRANSPORT_DISPOSED"));
      pending.clear();
    },
  };
}

export function createHttpTransport(options) {
  const endpoint = new URL("api/context-map", options.location);

  async function read() {
    const response = await options.fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (response.status === 404) throw new Error("SESSION_EXPIRED");
    if (!response.ok) throw new Error(`HTTP_SNAPSHOT_${response.status}`);
    return response.json();
  }

  return {
    initialSnapshot: read,
    refresh: read,
    dispose() {},
  };
}

export function createPageLifecycle({
  initialSnapshot,
  refresh,
  applySnapshot,
  setStatus,
  terminal,
  fallbackStatus,
  isHidden,
  setInterval,
  clearInterval,
  intervalMs = 750,
}) {
  let disposed = false;
  let expired = false;
  let pollTimer = null;
  let generation = 0;

  function active(requestGeneration) {
    return !disposed && !expired && generation === requestGeneration;
  }

  function stopPolling() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPolling() {
    if (disposed || expired || isHidden() || pollTimer !== null) return;
    pollTimer = setInterval(() => {
      refreshSnapshot();
    }, intervalMs);
  }

  function handleError(error, requestGeneration) {
    if (!active(requestGeneration)) return;
    if (error?.message === "SESSION_EXPIRED") {
      expired = true;
      generation += 1;
      stopPolling();
      terminal();
      return;
    }
    setStatus(fallbackStatus());
  }

  async function refreshSnapshot() {
    if (disposed || expired || isHidden()) return;
    const requestGeneration = ++generation;
    setStatus("refreshing");
    try {
      const snapshot = await refresh();
      if (active(requestGeneration)) applySnapshot(snapshot);
    } catch (error) {
      handleError(error, requestGeneration);
    }
  }

  return {
    async start() {
      if (disposed || expired) return;
      const requestGeneration = ++generation;
      try {
        const snapshot = await initialSnapshot();
        if (active(requestGeneration)) applySnapshot(snapshot);
      } catch (error) {
        handleError(error, requestGeneration);
      }
      if (active(requestGeneration)) startPolling();
    },
    refresh: refreshSnapshot,
    applyIncomingSnapshot(snapshot) {
      if (disposed || expired) return;
      generation += 1;
      applySnapshot(snapshot);
    },
    visibilityChanged(hidden) {
      if (hidden) {
        stopPolling();
        return Promise.resolve();
      }
      if (disposed || expired) return Promise.resolve();
      const result = refreshSnapshot();
      startPolling();
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopPolling();
    },
  };
}

export function createPageTransport(document, dependencies) {
  const mode = document
    .querySelector('meta[name="context-map-viewer-transport"]')
    ?.content;
  if (mode === "mcp") return createMcpTransport(dependencies);
  if (mode === "http") return createHttpTransport(dependencies);
  throw new Error("Unsupported context-map viewer transport");
}

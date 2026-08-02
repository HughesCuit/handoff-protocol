const SNAPSHOT_STATUSES = new Set([
  "access_denied",
  "empty",
  "invalid",
  "missing",
  "refreshing",
  "synced",
  "too_large",
  "too_many_nodes",
]);
const WATCH_MODES = new Set(["none", "polling", "watch"]);
const NODE_SECTIONS = new Set([
  "decisions",
  "excluded",
  "goal",
  "knowledge",
  "questions",
  "risks",
  "root",
  "status",
  "tasks",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isRenderNode(node) {
  return isRecord(node) &&
    typeof node.id === "string" &&
    NODE_SECTIONS.has(node.section) &&
    typeof node.text === "string" &&
    (node.taskState === null || node.taskState === "open" || node.taskState === "done") &&
    (node.risk === null || node.risk === "low" || node.risk === "medium" || node.risk === "high") &&
    typeof node.excluded === "boolean" &&
    (node.origin === "agent" || node.origin === "user") &&
    Array.isArray(node.children) &&
    node.children.every(isRenderNode);
}

function isSnapshot(snapshot) {
  if (!isRecord(snapshot) || !SNAPSHOT_STATUSES.has(snapshot.status)) return false;
  if (!isNullableString(snapshot.version) ||
      !isNullableString(snapshot.diagnostic) ||
      !isNullableString(snapshot.watchDiagnostic) ||
      !isNullableString(snapshot.bindingId)) {
    return false;
  }
  if (!Number.isSafeInteger(snapshot.nodeCount) || snapshot.nodeCount < 0) return false;
  if (!WATCH_MODES.has(snapshot.watchMode)) return false;
  if (snapshot.source !== ".handoff/context-map.md") return false;
  if (snapshot.tree !== null &&
      (!isRecord(snapshot.tree) ||
        !isRenderNode(snapshot.tree.root) ||
        !Number.isSafeInteger(snapshot.tree.nodeCount) ||
        snapshot.tree.nodeCount < 0 ||
        snapshot.tree.nodeCount !== snapshot.nodeCount)) {
    return false;
  }
  return snapshot.status !== "synced" ||
    (typeof snapshot.version === "string" && snapshot.tree !== null);
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
    const snapshot = await response.json();
    if (!isSnapshot(snapshot)) throw new Error("INVALID_SNAPSHOT");
    return snapshot;
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
  let refreshInFlight = null;
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
    pollTimer = setInterval(() => refreshSnapshot(), intervalMs);
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

  function refreshSnapshot() {
    if (disposed || expired || isHidden()) return;
    if (refreshInFlight) return refreshInFlight.promise;
    const requestGeneration = ++generation;
    setStatus("refreshing");
    const flight = {};
    refreshInFlight = flight;
    flight.promise = Promise.resolve()
      .then(() => refresh())
      .then((snapshot) => {
        if (active(requestGeneration)) applySnapshot(snapshot);
      })
      .catch((error) => handleError(error, requestGeneration))
      .finally(() => {
        if (refreshInFlight === flight) refreshInFlight = null;
      });
    return flight.promise;
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

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

const NODE_ID_RE = /^(goal|status|task|decision|question|risk|note|excluded)[1-9][0-9]*$/;

function isNodeDetail(detail) {
  return isRecord(detail) &&
    typeof detail.id === "string" &&
    typeof detail.version === "string" &&
    typeof detail.section === "string" &&
    typeof detail.label === "string" &&
    typeof detail.summary === "string" &&
    typeof detail.body === "string";
}

/**
 * Fetch one v3 node body lazily: `GET <sessionBase>node/<id>`.
 *
 * The ID grammar is validated before any network call (it never becomes a
 * path component otherwise), and the response is validated — the returned
 * `id` must equal the requested one and carry a `version` used by the caller
 * for cache invalidation. `signal` (an AbortSignal) rejects stale in-flight
 * requests when the selection changes.
 */
export async function loadNode(sessionBaseUrl, nodeId, signal, fetchImpl) {
  if (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)) {
    throw new Error("ID_INVALID");
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  const endpoint = new URL(`node/${nodeId}`, sessionBaseUrl);
  const response = await doFetch(endpoint, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (response.status === 404) throw new Error("NODE_NOT_FOUND");
  if (response.status === 409) throw new Error("MIGRATION_REQUIRED");
  if (!response.ok) throw new Error(`HTTP_NODE_${response.status}`);
  const detail = await response.json();
  if (!isNodeDetail(detail) || detail.id !== nodeId) throw new Error("INVALID_NODE_DETAIL");
  return detail;
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

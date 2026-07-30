import {
  buildVisibleTree,
  collapseAll,
  createViewState,
  expandAncestors,
  fitTreeTransform,
  focusNodeTransform,
  indexTree,
  isLabelTruncated,
  layoutTree,
  requestPictureInPicture,
  transitionSnapshotViewState,
  truncateLabel,
} from "./model.mjs";
import { createPageLifecycle, createPageTransport } from "./transports.mjs";

let snapshot = null;
let viewState = createViewState();
let dragging = null;
const INITIAL_OVERVIEW_BUILD_MARKER =
  "initial-overview:sync-gated-transition:v2";

const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const viewport = document.getElementById("viewport");
const linksLayer = document.getElementById("links");
const nodesLayer = document.getElementById("nodes");
const treePane = document.getElementById("tree-pane");
const treeRoot = document.getElementById("tree-root");
const mapPane = document.getElementById("map-pane");
const searchInput = document.getElementById("search");
const statusElement = document.getElementById("sync-status");
const emptyState = document.getElementById("empty-state");
const zoomValue = document.getElementById("zoom-value");
const detailsDrawer = document.getElementById("details-drawer");
const detailsTitle = document.getElementById("details-title");
const detailsPath = document.getElementById("details-path");
const detailsText = document.getElementById("details-text");
const detailsMeta = document.getElementById("details-meta");
let detailsReturnFocus = null;
const SVG_NS = "http://www.w3.org/2000/svg";

function mapViewport() {
  return { width: mapPane.clientWidth, height: mapPane.clientHeight };
}

function mapIsVisible() {
  return viewState.displayMode !== "tree";
}

function setTransform() {
  viewport.setAttribute(
    "transform",
    `translate(${viewState.transform.x} ${viewState.transform.y}) scale(${viewState.transform.scale})`,
  );
  zoomValue.textContent = `${Math.round(viewState.transform.scale * 100)}%`;
}

function iconFor(node) {
  if (node.taskState === "done") return "✓ ";
  if (node.taskState === "open") return "○ ";
  if (node.risk === "high") return "⚠ ";
  if (node.excluded) return "⊘ ";
  return "";
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function toggleFold(nodeId) {
  const folded = new Set(viewState.folded);
  if (folded.has(nodeId)) folded.delete(nodeId);
  else folded.add(nodeId);
  viewState = { ...viewState, folded };
  renderAllViews();
}

function selectNode(nodeId, source) {
  if (!viewState.tree?.root) return;
  const index = indexTree(viewState.tree.root);
  const selected = index.get(nodeId);
  if (!selected) return;
  const returnFocus = arguments[2] ?? document.activeElement;
  const wasDetailOpen = viewState.detailOpen;
  viewState = {
    ...viewState,
    selectedNodeId: nodeId,
    folded: expandAncestors(viewState.folded, nodeId, index),
    detailOpen: source === "map" || isLabelTruncated(selected.node.text),
  };
  renderAllViews();

  const renderedActions = document.querySelectorAll(
    source === "map" ? ".node-body" : ".tree-label",
  );
  detailsReturnFocus = [...renderedActions].find(
    (element) => element.dataset.nodeId === nodeId,
  ) ?? returnFocus;
  if (!wasDetailOpen && viewState.detailOpen) detailsTitle.focus();

  if (viewState.displayMode !== "tree") {
    const visible = buildVisibleTree(
      viewState.tree.root,
      viewState.folded,
      viewState.query,
    );
    const layout = layoutTree(visible.root);
    viewState = {
      ...viewState,
      transform: focusNodeTransform(
        layout,
        nodeId,
        mapViewport(),
        viewState.transform,
      ),
    };
    setTransform();
  }
}

function renderDetails() {
  const selected = viewState.tree?.root && viewState.selectedNodeId
    ? indexTree(viewState.tree.root).get(viewState.selectedNodeId)
    : null;
  const open = Boolean(viewState.detailOpen && selected);
  detailsDrawer.hidden = !open;
  if (!open) return;

  detailsText.textContent = selected.node.text;
  detailsPath.textContent = [...selected.ancestors, selected.node]
    .map((node) => node.text)
    .join(" › ");
  detailsMeta.replaceChildren();
  for (const [label, value] of [
    ["Section", selected.node.section],
    ["Task", selected.node.taskState],
    ["Risk", selected.node.risk],
    ["Excluded", selected.node.excluded ? "Yes" : null],
  ]) {
    if (!value) continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    detailsMeta.append(term, description);
  }
}

function closeDetails() {
  viewState = { ...viewState, detailOpen: false };
  renderDetails();
  if (detailsReturnFocus?.isConnected) detailsReturnFocus.focus();
  detailsReturnFocus = null;
}

function renderNavigationTree() {
  treeRoot.replaceChildren();
  if (!viewState.tree?.root) return;
  const visible = buildVisibleTree(
    viewState.tree.root,
    viewState.folded,
    viewState.query,
  );
  const authoritative = indexTree(viewState.tree.root);

  const renderNode = (node, level) => {
    const row = document.createElement("div");
    row.className = "tree-item";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(level));
    row.setAttribute("aria-selected", String(viewState.selectedNodeId === node.id));
    row.style.setProperty("--tree-depth", String(level - 1));
    const hasChildren = (authoritative.get(node.id)?.node.children?.length ?? 0) > 0;
    if (hasChildren) {
      row.setAttribute("aria-expanded", String(!viewState.folded.has(node.id)));
    }
    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.className = "tree-disclosure";
    disclosure.textContent = hasChildren
      ? (viewState.folded.has(node.id) ? "+" : "−")
      : "";
    disclosure.disabled = !hasChildren;
    disclosure.setAttribute(
      "aria-label",
      `${viewState.folded.has(node.id) ? "Expand" : "Collapse"} ${node.text}`,
    );
    disclosure.addEventListener("click", () => toggleFold(node.id));

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tree-label";
    label.dataset.nodeId = node.id;
    label.textContent = `${iconFor(node)}${node.text}`;
    label.addEventListener("click", () => selectNode(node.id, "tree", label));
    row.append(disclosure, label);
    treeRoot.append(row);
    for (const child of node.children ?? []) renderNode(child, level + 1);
  };
  renderNode(visible.root, 1);
}

function renderMap(focusFirstMatch = false) {
  if (!viewState.tree?.root) return;
  const mapSize = mapViewport();
  const visible = buildVisibleTree(
    viewState.tree.root,
    viewState.folded,
    viewState.query,
  );
  const layout = layoutTree(visible.root);
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const authoritative = indexTree(viewState.tree.root);
  linksLayer.replaceChildren();
  nodesLayer.replaceChildren();

  for (const link of layout.links) {
    const source = positions.get(link.sourceId);
    const target = positions.get(link.targetId);
    const startX = source.x + source.width;
    const startY = source.y + source.height / 2;
    const endX = target.x;
    const endY = target.y + target.height / 2;
    const bend = (startX + endX) / 2;
    linksLayer.append(svgElement("path", {
      class: "link",
      d: `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`,
    }));
  }

  for (const node of layout.nodes) {
    const classes = ["map-node"];
    if (node.section === "root") classes.push("root");
    else classes.push(`section-${node.section}`);
    if (node.taskState === "done") classes.push("done");
    if (node.risk === "high") classes.push("risk-high");
    if (node.excluded) classes.push("excluded");
    if (viewState.selectedNodeId === node.id) classes.push("selected");
    if (viewState.query && visible.matches.has(node.id)) classes.push("match");
    if (
      viewState.query &&
      !visible.matches.has(node.id) &&
      !visible.ancestors.has(node.id)
    ) {
      classes.push("dim");
    }

    const group = svgElement("g", {
      class: classes.join(" "),
      transform: `translate(${node.x} ${node.y})`,
    });
    const body = svgElement("g", {
      class: "node-body",
      tabindex: 0,
      role: "button",
      "aria-label": `Open details for ${node.text}`,
      "data-node-id": node.id,
    });
    const rect = svgElement("rect", {
      width: node.width,
      height: node.height,
      rx: 9,
    });
    const text = svgElement("text", { x: 13, y: 26 });
    text.textContent = `${iconFor(node)}${truncateLabel(node.text)}`;
    body.append(rect, text);
    if (isLabelTruncated(node.text)) {
      const affordance = svgElement("text", {
        class: "truncated-affordance",
        x: node.width - 14,
        y: 26,
        "aria-hidden": "true",
      });
      affordance.textContent = "…";
      body.append(affordance);
    }
    body.addEventListener("click", (event) => {
      event.stopPropagation();
      selectNode(node.id, "map", body);
    });
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectNode(node.id, "map", body);
      }
    });
    group.append(body);

    const hasChildren = (authoritative.get(node.id)?.node.children?.length ?? 0) > 0;
    if (hasChildren) {
      const disclosure = svgElement("g", {
        class: "node-disclosure",
        role: "button",
        tabindex: 0,
        "aria-label": `${viewState.folded.has(node.id) ? "Expand" : "Collapse"} ${node.text}`,
      });
      const badge = svgElement("circle", {
        class: "fold-badge",
        cx: node.width,
        cy: node.height / 2,
        r: 8,
      });
      const badgeText = svgElement("text", {
        class: "fold-badge-text",
        x: node.width,
        y: node.height / 2 + 3.5,
        "text-anchor": "middle",
      });
      badgeText.textContent = viewState.folded.has(node.id) ? "+" : "−";
      disclosure.append(badge, badgeText);
      disclosure.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFold(node.id);
      });
      disclosure.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleFold(node.id);
        }
      });
      group.append(disclosure);
    }
    nodesLayer.append(group);
  }
  canvas.setAttribute(
    "viewBox",
    `0 0 ${Math.max(mapSize.width, 320)} ${Math.max(mapSize.height, 240)}`,
  );
  if (focusFirstMatch && visible.matches.size > 0) {
    viewState = {
      ...viewState,
      transform: focusNodeTransform(
        layout,
        visible.matches.values().next().value,
        mapSize,
        viewState.transform,
      ),
    };
  }
  setTransform();
}

function renderDisplayMode(mode = viewState.displayMode) {
  stage.dataset.mode = mode;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  }
}

function renderAllViews({ focusFirstMatch = false } = {}) {
  renderDisplayMode();
  renderNavigationTree();
  if (mapIsVisible()) renderMap(focusFirstMatch);
  renderDetails();
}

function setDisplayMode(mode) {
  if (!["tree", "map", "split"].includes(mode)) return;
  viewState = { ...viewState, displayMode: mode };
  renderAllViews();
}

function setStatus(status) {
  const labels = {
    synced: "Synced",
    refreshing: "Refreshing",
    missing: "Missing",
    empty: "Empty",
    invalid: "Parse error",
    too_large: "File too large",
    too_many_nodes: "Too many nodes",
    access_denied: "Access denied",
    watcher_unavailable: "Polling",
    expired: "Session expired",
  };
  statusElement.textContent = labels[status] ?? "Unavailable";
  statusElement.className = `sync-status ${status === "synced" ? "synced" : ""} ${
    ["invalid", "too_large", "too_many_nodes", "access_denied", "expired"].includes(status)
      ? "error"
      : ""
  }`;
}

function emptyMessage(status) {
  const messages = {
    missing: "No .handoff/context-map.md yet. Run the Handoff save flow to create it.",
    empty: "The Context Map exists but has no semantic nodes yet.",
    invalid: "The Context Map could not be parsed. The last valid map remains visible.",
    too_large: "The Context Map exceeds the 2 MiB viewer limit.",
    too_many_nodes: "The Context Map exceeds the 2,000-node viewer limit.",
    access_denied: "The active workspace Context Map is not available to this read-only viewer.",
  };
  return messages[status] ?? "Waiting for a Context Map snapshot…";
}

function applySnapshot(next) {
  if (!next || typeof next !== "object") return;
  snapshot = next;
  setStatus(next.status);
  const nextBindingId = next.bindingId ?? viewState.bindingId;
  const nextDisplayMode =
    viewState.bindingId !== null && viewState.bindingId !== nextBindingId
      ? "split"
      : viewState.displayMode;
  renderDisplayMode(nextDisplayMode);
  viewState = transitionSnapshotViewState(
    viewState,
    next,
    mapViewport(),
  );
  searchInput.value = viewState.query;
  renderDisplayMode();
  if (viewState.tree?.root) {
    emptyState.hidden = true;
    canvas.hidden = false;
    treePane.hidden = false;
    renderAllViews();
    return;
  }
  canvas.hidden = true;
  treePane.hidden = true;
  treeRoot.replaceChildren();
  emptyState.hidden = false;
  emptyState.textContent = emptyMessage(next.status);
}

function showTerminalEmptyState(message) {
  viewState = { ...viewState, tree: null };
  canvas.hidden = true;
  treePane.hidden = true;
  treeRoot.replaceChildren();
  emptyState.hidden = false;
  emptyState.textContent = message;
  setStatus("expired");
}

let lifecycle;
const transport = createPageTransport(document, {
  parentWindow: window.parent,
  windowObject: window,
  fetch: window.fetch.bind(window),
  location: window.location,
  onSnapshot: (next) => lifecycle?.applyIncomingSnapshot(next),
});
lifecycle = createPageLifecycle({
  initialSnapshot: () => transport.initialSnapshot(),
  refresh: () => transport.refresh(snapshot?.bindingId),
  applySnapshot,
  setStatus,
  terminal: () => showTerminalEmptyState("This Viewer session expired. Reopen Context Map Viewer."),
  fallbackStatus: () => snapshot?.status ?? "invalid",
  isHidden: () => document.hidden,
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
});

function zoomAt(factor, centerX = mapPane.clientWidth / 2, centerY = mapPane.clientHeight / 2) {
  if (!mapIsVisible()) return;
  const nextScale = Math.max(
    0.35,
    Math.min(2.5, viewState.transform.scale * factor),
  );
  const ratio = nextScale / viewState.transform.scale;
  viewState = {
    ...viewState,
    transform: {
      x: centerX - (centerX - viewState.transform.x) * ratio,
      y: centerY - (centerY - viewState.transform.y) * ratio,
      scale: nextScale,
    },
  };
  setTransform();
}

function fitView() {
  if (!viewState.tree?.root || !mapIsVisible()) return;
  viewState = {
    ...viewState,
    transform: fitTreeTransform(
      viewState.tree.root,
      viewState.folded,
      viewState.query,
      mapViewport(),
    ),
  };
  setTransform();
}

searchInput.addEventListener("input", () => {
  viewState = { ...viewState, query: searchInput.value };
  renderAllViews({ focusFirstMatch: Boolean(viewState.query.trim()) });
});
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setDisplayMode(button.dataset.mode));
}
document.getElementById("zoom-in").addEventListener("click", () => zoomAt(1.2));
document.getElementById("zoom-out").addEventListener("click", () => zoomAt(1 / 1.2));
document.getElementById("fit").addEventListener("click", fitView);
document.getElementById("details-close").addEventListener("click", closeDetails);
document.getElementById("expand").addEventListener("click", () => {
  viewState = { ...viewState, folded: new Set() };
  renderAllViews();
});
document.getElementById("collapse").addEventListener("click", () => {
  if (!viewState.tree?.root) return;
  viewState = {
    ...viewState,
    folded: collapseAll(viewState.tree.root),
  };
  renderAllViews();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = mapPane.getBoundingClientRect();
  zoomAt(
    event.deltaY < 0 ? 1.1 : 1 / 1.1,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
}, { passive: false });
canvas.addEventListener("pointerdown", (event) => {
  if (event.target.closest?.(".map-node")) return;
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragging || dragging.pointerId !== event.pointerId) return;
  viewState = {
    ...viewState,
    transform: {
      ...viewState.transform,
      x: viewState.transform.x + event.clientX - dragging.x,
      y: viewState.transform.y + event.clientY - dragging.y,
    },
  };
  dragging = { ...dragging, x: event.clientX, y: event.clientY };
  setTransform();
});
canvas.addEventListener("pointerup", (event) => {
  if (dragging?.pointerId !== event.pointerId) return;
  dragging = null;
  canvas.classList.remove("dragging");
  canvas.releasePointerCapture(event.pointerId);
});

document.addEventListener("visibilitychange", () => {
  lifecycle.visibilityChanged(document.hidden);
});

window.addEventListener("resize", () => renderAllViews());
window.addEventListener("pagehide", () => {
  lifecycle.dispose();
  transport.dispose();
}, { once: true });
document.documentElement.dataset.initialOverviewBehavior =
  INITIAL_OVERVIEW_BUILD_MARKER;
setTransform();
if (document.querySelector('meta[name="context-map-viewer-transport"]')?.content === "mcp") {
  requestPictureInPicture(window.openai);
}
lifecycle.start();

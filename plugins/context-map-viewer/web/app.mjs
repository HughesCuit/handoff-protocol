import {
  buildVisibleTree,
  collapseAll,
  focusNodeTransform,
  layoutTree,
  reconcileFoldState,
  requestPictureInPicture,
} from "./model.mjs";

const pending = new Map();
let requestId = 1;
let snapshot = null;
let lastTree = null;
let folded = new Set();
let query = "";
let transform = { x: 36, y: 36, scale: 1 };
let pollTimer = null;
let dragging = null;

const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const viewport = document.getElementById("viewport");
const linksLayer = document.getElementById("links");
const nodesLayer = document.getElementById("nodes");
const searchInput = document.getElementById("search");
const statusElement = document.getElementById("sync-status");
const emptyState = document.getElementById("empty-state");
const zoomValue = document.getElementById("zoom-value");
const SVG_NS = "http://www.w3.org/2000/svg";

function request(method, params) {
  const id = requestId++;
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function setTransform() {
  viewport.setAttribute(
    "transform",
    `translate(${transform.x} ${transform.y}) scale(${transform.scale})`,
  );
  zoomValue.textContent = `${Math.round(transform.scale * 100)}%`;
}

function iconFor(node) {
  if (node.taskState === "done") return "✓ ";
  if (node.taskState === "open") return "○ ";
  if (node.risk === "high") return "⚠ ";
  if (node.excluded) return "⊘ ";
  return "";
}

function truncate(text, limit = 28) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function fullNodeMap(root) {
  const map = new Map();
  const visit = (node) => {
    map.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return map;
}

function renderTree(focusFirstMatch = false) {
  if (!lastTree?.root) return;
  const visible = buildVisibleTree(lastTree.root, folded, query);
  const layout = layoutTree(visible.root);
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const authoritative = fullNodeMap(lastTree.root);
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
    if (query && visible.matches.has(node.id)) classes.push("match");
    if (query && !visible.matches.has(node.id) && !visible.ancestors.has(node.id)) {
      classes.push("dim");
    }

    const group = svgElement("g", {
      class: classes.join(" "),
      transform: `translate(${node.x} ${node.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": node.text,
    });
    group.append(svgElement("rect", {
      width: node.width,
      height: node.height,
      rx: 9,
    }));
    const text = svgElement("text", { x: 13, y: 26 });
    text.textContent = `${iconFor(node)}${truncate(node.text)}`;
    group.append(text);

    const hasChildren = (authoritative.get(node.id)?.children?.length ?? 0) > 0;
    if (hasChildren) {
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
      badgeText.textContent = folded.has(node.id) ? "+" : "−";
      group.append(badge, badgeText);
      const toggle = () => {
        const next = new Set(folded);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        folded = next;
        renderTree();
      };
      group.addEventListener("click", toggle);
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
    nodesLayer.append(group);
  }
  canvas.setAttribute(
    "viewBox",
    `0 0 ${Math.max(stage.clientWidth, 320)} ${Math.max(stage.clientHeight, 240)}`,
  );
  if (focusFirstMatch && visible.matches.size > 0) {
    transform = focusNodeTransform(
      layout,
      visible.matches.values().next().value,
      { width: stage.clientWidth, height: stage.clientHeight },
      transform,
    );
  }
  setTransform();
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
  };
  statusElement.textContent = labels[status] ?? "Unavailable";
  statusElement.className = `sync-status ${status === "synced" ? "synced" : ""} ${
    ["invalid", "too_large", "too_many_nodes", "access_denied"].includes(status)
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
  if (next.tree?.root) {
    folded = reconcileFoldState(folded, next.tree.root);
    lastTree = next.tree;
    emptyState.hidden = true;
    canvas.hidden = false;
    renderTree();
    return;
  }
  if (lastTree?.root) {
    emptyState.hidden = true;
    canvas.hidden = false;
    renderTree();
    return;
  }
  canvas.hidden = true;
  emptyState.hidden = false;
  emptyState.textContent = emptyMessage(next.status);
}

function unwrapToolResult(result) {
  return result?.structuredContent ??
    result?.content?.structuredContent ??
    result?.result?.structuredContent ??
    null;
}

async function refresh() {
  if (document.hidden) return;
  setStatus("refreshing");
  try {
    const result = await request("tools/call", {
      name: "get_context_map",
      arguments: {},
    });
    const next = unwrapToolResult(result);
    if (next) applySnapshot(next);
  } catch {
    setStatus(snapshot?.status ?? "invalid");
  }
}

function zoomAt(factor, centerX = stage.clientWidth / 2, centerY = stage.clientHeight / 2) {
  const nextScale = Math.max(0.35, Math.min(2.5, transform.scale * factor));
  const ratio = nextScale / transform.scale;
  transform = {
    x: centerX - (centerX - transform.x) * ratio,
    y: centerY - (centerY - transform.y) * ratio,
    scale: nextScale,
  };
  setTransform();
}

function fitView() {
  if (!lastTree?.root) return;
  const visible = buildVisibleTree(lastTree.root, folded, query);
  const layout = layoutTree(visible.root);
  const availableWidth = Math.max(200, stage.clientWidth - 40);
  const availableHeight = Math.max(160, stage.clientHeight - 40);
  const scale = Math.max(
    0.35,
    Math.min(1.4, availableWidth / layout.width, availableHeight / layout.height),
  );
  transform = { x: 20, y: 20, scale };
  setTransform();
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
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
    applySnapshot(message.params?.structuredContent);
  }
});

searchInput.addEventListener("input", () => {
  query = searchInput.value;
  renderTree(Boolean(query.trim()));
});
document.getElementById("zoom-in").addEventListener("click", () => zoomAt(1.2));
document.getElementById("zoom-out").addEventListener("click", () => zoomAt(1 / 1.2));
document.getElementById("fit").addEventListener("click", fitView);
document.getElementById("expand").addEventListener("click", () => {
  folded = new Set();
  renderTree();
});
document.getElementById("collapse").addEventListener("click", () => {
  if (!lastTree?.root) return;
  folded = collapseAll(lastTree.root);
  renderTree();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
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
  transform.x += event.clientX - dragging.x;
  transform.y += event.clientY - dragging.y;
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
  if (document.hidden) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else {
    refresh();
    pollTimer ??= setInterval(refresh, 750);
  }
});

window.addEventListener("resize", () => setTransform());
setTransform();
if (window.openai?.toolOutput) applySnapshot(window.openai.toolOutput);
requestPictureInPicture(window.openai);
pollTimer = setInterval(refresh, 750);

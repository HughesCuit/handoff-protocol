function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  for (const child of node.children ?? []) walk(child, visit, [...ancestors, node]);
}

export const NODE_LABEL_LIMIT = 28;

export function collectIds(root) {
  const ids = new Set();
  walk(root, (node) => ids.add(node.id));
  return ids;
}

export function indexTree(root) {
  const index = new Map();
  walk(root, (node, ancestors) => {
    index.set(node.id, { node, ancestors });
  });
  return index;
}

export function expandAncestors(folded, nodeId, index) {
  const next = new Set(folded);
  for (const ancestor of index.get(nodeId)?.ancestors ?? []) {
    next.delete(ancestor.id);
  }
  return next;
}

export function reconcileSelectedNode(selectedNodeId, root) {
  if (!selectedNodeId || !root) return null;
  return collectIds(root).has(selectedNodeId) ? selectedNodeId : null;
}

export function isLabelTruncated(text, limit = NODE_LABEL_LIMIT) {
  return String(text).length > limit;
}

export function truncateLabel(text, limit = NODE_LABEL_LIMIT) {
  const value = String(text);
  return isLabelTruncated(value, limit)
    ? `${value.slice(0, limit - 1)}…`
    : value;
}

export function reconcileFoldState(previous, root) {
  const available = collectIds(root);
  return new Set([...previous].filter((id) => available.has(id)));
}

export function collapseAll(root) {
  return new Set((root.children ?? []).map((node) => node.id));
}

export function initialOverviewFolds(root) {
  return new Set(
    (root?.children ?? [])
      .filter((node) => (node.children?.length ?? 0) > 0)
      .map((node) => node.id),
  );
}

export function needsOverviewInitialization(
  overviewPending,
  bindingId,
  status,
  root,
) {
  return Boolean(
    overviewPending &&
    root &&
    bindingId &&
    status === "synced",
  );
}

export function matchSearch(root, query) {
  const tokens = String(query)
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const matches = new Set();
  const ancestors = new Set();
  if (tokens.length === 0) return { matches, ancestors };

  walk(root, (node, parents) => {
    const path = [...parents, node]
      .map((item) => item.text ?? "")
      .join(" ")
      .toLocaleLowerCase();
    if (tokens.every((token) => path.includes(token))) {
      matches.add(node.id);
      for (const parent of parents) ancestors.add(parent.id);
    }
  });
  return { matches, ancestors };
}

export function buildVisibleTree(root, folded, query) {
  const search = matchSearch(root, query);

  function clone(node) {
    const revealForSearch = search.ancestors.has(node.id);
    const hideChildren = folded.has(node.id) && !revealForSearch;
    return {
      ...node,
      children: hideChildren ? [] : (node.children ?? []).map(clone),
      hasHiddenChildren: hideChildren && (node.children?.length ?? 0) > 0,
    };
  }

  return { root: clone(root), ...search };
}

export function fitTreeTransform(root, folded, query, stage) {
  const visible = buildVisibleTree(root, folded, query);
  const layout = layoutTree(visible.root);
  const availableWidth = Math.max(200, stage.width - 40);
  const availableHeight = Math.max(160, stage.height - 40);
  return {
    x: 20,
    y: 20,
    scale: Math.max(
      0.35,
      Math.min(
        1.4,
        availableWidth / layout.width,
        availableHeight / layout.height,
      ),
    ),
  };
}

export function createViewState() {
  return {
    bindingId: null,
    tree: null,
    folded: new Set(),
    query: "",
    transform: { x: 36, y: 36, scale: 1 },
    overviewPending: true,
    displayMode: "split",
    selectedNodeId: null,
    detailOpen: false,
  };
}

export function transitionSnapshotViewState(previous, next, stage) {
  if (!next || typeof next !== "object") return previous;
  const nextBindingId = next.bindingId ?? previous.bindingId;
  const scoped = bindingChanged(previous.bindingId, nextBindingId)
    ? {
        ...previous,
        bindingId: nextBindingId,
        tree: null,
        folded: new Set(),
        query: "",
        overviewPending: true,
        displayMode: "split",
        selectedNodeId: null,
        detailOpen: false,
      }
    : { ...previous, bindingId: nextBindingId };
  const root = next.tree?.root;
  if (!root) return scoped;

  if (needsOverviewInitialization(
    scoped.overviewPending,
    nextBindingId,
    next.status,
    root,
  )) {
    const folded = initialOverviewFolds(root);
    const selectedNodeId = reconcileSelectedNode(scoped.selectedNodeId, root);
    return {
      ...scoped,
      tree: next.tree,
      folded,
      transform: fitTreeTransform(root, folded, scoped.query, stage),
      overviewPending: false,
      selectedNodeId,
      detailOpen: selectedNodeId ? scoped.detailOpen : false,
    };
  }

  if (next.status !== "synced" && scoped.tree?.root) return scoped;
  const selectedNodeId = reconcileSelectedNode(scoped.selectedNodeId, root);
  return {
    ...scoped,
    tree: next.tree,
    folded: reconcileFoldState(scoped.folded, root),
    selectedNodeId,
    detailOpen: selectedNodeId ? scoped.detailOpen : false,
  };
}

export function layoutTree(root, options = {}) {
  const horizontalGap = options.horizontalGap ?? 220;
  const verticalGap = options.verticalGap ?? 68;
  const padding = options.padding ?? 48;
  const nodes = [];
  const links = [];
  let nextLeafY = padding;

  function place(node, depth, parent = null) {
    const entry = {
      ...node,
      x: padding + depth * horizontalGap,
      y: 0,
      width: Math.max(112, Math.min(220, 42 + String(node.text ?? "").length * 7)),
      height: 42,
      depth,
    };
    nodes.push(entry);
    if (parent) links.push({ sourceId: parent.id, targetId: node.id });

    const children = node.children ?? [];
    if (children.length === 0) {
      entry.y = nextLeafY;
      nextLeafY += verticalGap;
    } else {
      for (const child of children) place(child, depth + 1, entry);
      const first = nodes.find((item) => item.id === children[0].id);
      const last = nodes.find((item) => item.id === children.at(-1).id);
      entry.y = (first.y + last.y) / 2;
    }
    return entry;
  }

  place(root, 0);
  const width = Math.max(
    320,
    ...nodes.map((node) => node.x + node.width + padding),
  );
  const height = Math.max(240, nextLeafY - verticalGap + padding);
  return { nodes, links, width, height };
}

export function focusNodeTransform(layout, nodeId, stage, current) {
  const node = layout.nodes.find((item) => item.id === nodeId);
  if (!node) return current;
  const scale = current.scale;
  return {
    x: stage.width / 2 - (node.x + node.width / 2) * scale,
    y: stage.height / 2 - (node.y + node.height / 2) * scale,
    scale,
  };
}

export function bindingChanged(previous, next) {
  return previous !== null && previous !== next;
}

export async function requestPictureInPicture(host) {
  if (typeof host?.requestDisplayMode !== "function") return false;
  try {
    await Promise.resolve(host.requestDisplayMode({ mode: "picture-in-picture" }));
    return true;
  } catch {
    return false;
  }
}

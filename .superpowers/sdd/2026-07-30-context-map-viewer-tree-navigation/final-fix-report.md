# Context Map Viewer final fix report

Date: 2026-08-01

Branch: `codex/context-map-side-browser`

Commit subject: `fix(viewer): resolve final navigation review`

## Scope and changes

- Added a revision guard in `web/app.mjs` so a 750 ms refresh with the same
  binding and version updates sync status without rebuilding the tree, map, or
  details DOM.
- Made terminal session expiry clear the authoritative tree, selection, drawer
  state, drawer text/path/metadata, focus-return descriptor, pending map focus,
  and rendered SVG nodes before focusing the terminal message.
- Added `aria-current` plus selected-state wording to each map node action, so
  the current selection is available without relying on stroke color.
- Constrained the details drawer to the visible map pane in split/map modes. It
  is capped at 360 px on larger panes, shrinks to the 340 px map pane at 520 px,
  and uses the full 390 px content width below the 420 px breakpoint. Global
  `border-box` sizing keeps padding inside those bounds.
- Added a pending map-focus target. Tree-only selection now records the target
  and consumes it after Map/Both becomes measurable, without changing zoom.
- Kept the low-risk minor improvement from the behavior test: matching tree rows
  receive a non-color search highlight, and a Tree-only search likewise defers
  map focus until Map/Both is visible.
- Kept the prior agent's `happy-dom` test approach after technical review,
  pinned it to `20.11.1`, and loaded the real standalone template, app module,
  and stylesheet in the behavior harness. The harness stubs only external fetch,
  interval scheduling, and browser layout measurements.
- Regenerated `dist/widget.html` and the standalone app/styles from source.

The unrelated worktree-root `package-lock.json` was neither modified nor staged.

## Important review items and evidence

1. **Unchanged polls preserve focus without rerendering**
   - `same-binding polls preserve the focused details opener and tree item`
     proves both `activeElement` and the original connected DOM node survive two
     same-version polls.
   - The first RED run failed at the focus/identity assertion; the GREEN run
     passes through `snapshotRevisionIsUnchanged()`.

2. **Session expiry clears stale details/text**
   - `session expiry clears open details, selection, and focus before showing
     terminal state` starts with open map details, returns HTTP 404 on refresh,
     then asserts a hidden drawer, empty detail text, no current map selection,
     and focus on the terminal message.

3. **Map selection has a non-color accessible state**
   - `map selection exposes current state and drawer bounds stay inside the map
     pane` asserts `aria-current="true"` for the selected node and `"false"` for
     an unselected peer.
   - The selected node's accessible label also changes to `Selected node: …`.

4. **520 px drawer does not cover the tree**
   - The same DOM test measures a 520 px stage with a 180 px tree and 340 px map,
     then asserts drawer `left: 180px`, `width: 340px`, and `border-box` sizing.
   - It additionally checks a wide 800 px stage retains the 360 px cap and a
     390 px compact stage uses the full content width.

5. **Tree-only selection retains pending map focus**
   - `tree selection retains its map focus target until Map is measurable`
     asserts no transform change in Tree mode, a transform change after switching
     to Map, and identical zoom before/after.
   - `tree search highlights matches and defers map focus until Map is measurable`
     covers the low-risk search variant and visible tree match styling.

## Verification commands and results

- `node --test tests/web-app-dom.test.mjs`
  - Initial RED: 0 passed, 5 failed for the five review behaviors.
  - Final GREEN: 5 passed, 0 failed.
- `node --test tests/web-app-dom.test.mjs tests/web-interface-contract.test.mjs tests/web-model.test.mjs tests/web-view-state.test.mjs tests/transports.test.mjs`
  - 46 passed, 0 failed.
- `npm test` in `plugins/context-map-viewer` (loopback tests run outside the
  port-restricted sandbox)
  - Build succeeded; 99 passed, 0 failed.
  - One intervening pre-commit rerun produced a single pre-existing
    `context-store.test.mjs` file-watcher timeout (98 passed, 1 failed). The
    exact test then passed in isolation, and the fresh full-suite rerun above
    passed 99/99. No watcher code or timeout was changed in this scoped wave.
- `npm pack --dry-run --cache /private/tmp/context-map-viewer-npm-cache`
  - Succeeded; 37 files, 203.0 kB package, expected source/tests/dist included.
- `node --test "tests/**/*.test.mjs"` from the repository root
  - 167 passed, 0 failed, 1 skipped (`deno not installed`).
- `deno test --allow-read --allow-write --allow-env --allow-run tests/`
  - Not run because Deno is not installed; the plan marks this verification as
    conditional.
- `rg -n 'snapshotRevisionIsUnchanged|aria-current|pendingMapFocusNodeId|positionDetailsDrawer|tree-item\\.match|box-sizing: border-box' dist/standalone/app.mjs dist/standalone/styles.css dist/widget.html`
  - Confirmed rebuilt standalone and widget artifacts contain the fixes.
- `git diff --check`
  - Passed with no output.

## Commit

- Branch: `codex/context-map-side-browser`
- Subject: `fix(viewer): resolve final navigation review`
- The immutable SHA is reported in the final handoff; a file cannot embed the
  hash of the commit that contains itself.

## Concerns

- No blocking or product concerns remain.
- The existing file-watcher integration test showed one transient 1-second
  timeout under full-suite load before passing both in isolation and in the
  final full rerun. This did not involve the Viewer UI change paths.
- Deno was unavailable, so its optional parity suite was not rerun in this wave;
  the root Node parity test recorded that condition as its single skip.
- The no-rerender guard relies on the existing snapshot contract that content
  changes produce a new `version`; `context-store.test.mjs` covers that contract.

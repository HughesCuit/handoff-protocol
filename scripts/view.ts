#!/usr/bin/env -S deno run
// @ts-nocheck

/**
 * Handoff Protocol - View Command (Deno)
 *
 * The Context Map Viewer daemon is Node.js-only in this release. This Deno
 * command recognizes `view` and returns the stable VIEW_REQUIRES_NODE error
 * with an actionable Node command. It does not implement a second server, and
 * every other Handoff Deno command remains unchanged.
 *
 * Usage:
 *   deno run scripts/view.ts [--idle-minutes N] [--json]
 */

const NODE_COMMAND = "node scripts/node/view.mjs";

function emit() {
  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify({
      status: "error",
      error: "VIEW_REQUIRES_NODE",
      message: "The Context Map Viewer daemon requires Node.js.",
      nodeCommand: NODE_COMMAND,
    }));
  } else {
    console.error("VIEW_REQUIRES_NODE");
    console.error("The Context Map Viewer daemon requires Node.js.");
    console.error(`Run: ${NODE_COMMAND}`);
  }
}

emit();
Deno.exit(1);

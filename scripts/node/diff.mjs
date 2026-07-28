#!/usr/bin/env node

/**
 * Handoff Protocol - Diff Command (Node.js Reference Implementation)
 *
 * Usage:
 *   node diff.mjs [--from latest|<snapshot-id>] [--format markdown|json]
 *
 * Compares a semantic snapshot (default: the latest one under
 * .handoff/history/snapshots/) against the current Context Map and reports
 * added, removed, edited, moved, and task-state-changed nodes. The command is
 * strictly read-only: it never mutates snapshots or the current state.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runDiff } from "../context-diff.mjs";

// ── Filesystem adapter for the shared core (read-only) ───────────────────────

const io = {
  readFile: async (p) => readFileSync(p, "utf-8"),
  listDir: async (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
};

// ── Entry Point ──────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const namedArgs = {};
const positionalArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--from" || rawArgs[i] === "--format") {
    const value = rawArgs[i + 1];
    // A missing value or a following flag must not be bound as the value or
    // fall into the positional parse (parity with load.mjs).
    if (value === undefined || value.startsWith("--")) {
      console.error(`Error: ${rawArgs[i]} requires a value`);
      process.exit(1);
    }
    namedArgs[rawArgs[i].slice(2)] = value;
    i++;
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

const USAGE = `Usage:
  node diff.mjs [--from latest|<snapshot-id>] [--format markdown|json]`;

async function main() {
  if (positionalArgs.length > 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const result = await runDiff(
    { handoffDir: join(process.cwd(), ".handoff") },
    io,
    { from: namedArgs.from, format: namedArgs.format }
  );
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    if (result.guidance) console.error(result.guidance);
    process.exit(1);
  }
  console.log(result.output);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

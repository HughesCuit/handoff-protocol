#!/usr/bin/env -S deno run --allow-read
// @ts-nocheck

/**
 * Handoff Protocol - Diff Command (Deno Implementation)
 *
 * Usage:
 *   deno run --allow-read diff.ts [--from latest|<snapshot-id>] [--format markdown|json]
 *
 * Behavior is identical to scripts/node/diff.mjs; all diff logic lives in the
 * shared, runtime-agnostic core (scripts/context-diff.mjs). The command is
 * strictly read-only: it never mutates snapshots or the current state.
 */

import { runDiff } from "./context-diff.mjs";

// ── Filesystem adapter for the shared core (read-only) ───────────────────────

const io = {
  readFile: (p) => Deno.readTextFile(p),
  listDir: async (p) => {
    try {
      const names = [];
      for await (const entry of Deno.readDir(p)) names.push(entry.name);
      return names;
    } catch {
      return [];
    }
  },
};

// ── Entry Point ──────────────────────────────────────────────────────────────

const rawArgs = Deno.args;
const namedArgs = {};
const positionalArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--from" || rawArgs[i] === "--format") {
    const value = rawArgs[i + 1];
    // A missing value or a following flag must not be bound as the value or
    // fall into the positional parse (parity with load.mjs).
    if (value === undefined || value.startsWith("--")) {
      console.error(`Error: ${rawArgs[i]} requires a value`);
      Deno.exit(1);
    }
    namedArgs[rawArgs[i].slice(2)] = value;
    i++;
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

const USAGE = `Usage:
  diff.ts [--from latest|<snapshot-id>] [--format markdown|json]`;

async function main() {
  if (positionalArgs.length > 0) {
    console.error(USAGE);
    Deno.exit(1);
  }

  const result = await runDiff(
    { handoffDir: `${Deno.cwd()}/.handoff` },
    io,
    { from: namedArgs.from, format: namedArgs.format }
  );
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    if (result.guidance) console.error(result.guidance);
    Deno.exit(1);
  }
  console.log(result.output);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  Deno.exit(1);
});

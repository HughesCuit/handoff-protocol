#!/usr/bin/env node

/**
 * Skills CLI discovery smoke check.
 *
 * Verifies that the external Skills CLI (`npx skills add . --list`) discovers
 * exactly one skill in this repository and that the skill is named `handoff`.
 * This does not rely on the CLI's exit code alone; it parses and asserts on
 * the actual output.
 *
 * Cross-platform: uses Node's child_process only, no grep or shell pipes.
 *
 * Usage: node scripts/verify-skills-discovery.mjs
 * Exit code 0 on success, 1 on any failed assertion.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["--yes", "skills@latest", "add", ".", "--list"];

const ESC = String.fromCharCode(27); // \u001b
const BEL = String.fromCharCode(7); // 
const CSI_PATTERN = new RegExp(ESC + "\\[[0-9;?]*[a-zA-Z]", "g");
const OSC_PATTERN = new RegExp(ESC + "\\][^" + BEL + "]*" + BEL, "g");
const BOX_CHARS = "│◇●○◆■└┌┐┘├┤┬┴┼╵╴╶╷";

function stripAnsi(text) {
  return text.replace(CSI_PATTERN, "").replace(OSC_PATTERN, "");
}

function stripLinePrefix(line) {
  return line.replace(new RegExp(`^[\\s${BOX_CHARS}]+`), "").trim();
}

function fail(message, output) {
  console.error(`Skills CLI discovery check FAILED: ${message}`);
  if (output) {
    console.error("\n----- skills CLI output -----\n" + output + "\n-----------------------------");
  }
  process.exit(1);
}

function assertDiscovery(output) {
  const foundMatch = output.match(/Found\s+(\d+)\s+skill/i);
  if (!foundMatch) {
    fail("could not find a 'Found N skill' line in the CLI output", output);
  }
  const count = Number(foundMatch[1]);
  if (count !== 1) {
    fail(`expected exactly 1 skill, but the CLI reported ${count}`, output);
  }

  const names = output
    .split("\n")
    .map(stripLinePrefix)
    .filter((line) => line.length > 0);
  if (!names.includes("handoff")) {
    fail("expected the discovered skill to be named 'handoff'", output);
  }
}

const child = execFile(npxCommand, args, { cwd: repoRoot }, (error, stdout, stderr) => {
  const output = stripAnsi(`${stdout}\n${stderr}`);
  if (error) {
    fail(`skills CLI exited with code ${error.code ?? "unknown"}`, output);
  }
  assertDiscovery(output);
  console.log("Skills CLI discovery OK: found exactly 1 skill named 'handoff'.");
});

child.on("error", (error) => {
  fail(`failed to launch '${npxCommand}': ${error.message}`);
});

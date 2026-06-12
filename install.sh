#!/bin/bash
# Install handoff skill to project-local agent directories (symlinks)
# Usage: bash install.sh [--project /path/to/project]
#
# Creates symlinks in the project's agent directories:
#   .opencode/skills/handoff -> (repo root)
#   .claude/skills/handoff   -> (repo root)
#   .mimocode/skills/handoff -> (repo root)
#   .agents/skills/handoff   -> (repo root)  (Codex project convention)
#
# Run this from inside your target project, or pass --project.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${2:-.}"

# Parse --project flag
if [ "${1:-}" = "--project" ] && [ -n "${2:-}" ]; then
  PROJECT_DIR="$2"
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo "Skill source: $SCRIPT_DIR"
echo "Target project: $PROJECT_DIR"
echo ""

installed=0

install_link() {
  local agent_dir="$1"
  local agent_name="$2"
  local target="$PROJECT_DIR/$agent_dir/skills/handoff"

  # Create parent dirs
  mkdir -p "$PROJECT_DIR/$agent_dir/skills"

  # Remove old install (symlink or directory)
  if [ -L "$target" ]; then
    rm "$target"
    echo "  Removed old symlink: $target"
  elif [ -d "$target" ]; then
    rm -rf "$target"
    echo "  Removed old directory: $target"
  fi

  ln -s "$SCRIPT_DIR" "$target"
  echo "  ✓ $agent_name: $target -> $SCRIPT_DIR"
  installed=$((installed + 1))
}

# Detect and install for each agent
echo "Installing project-local skill..."
echo ""

# OpenCode
install_link ".opencode" "OpenCode"

# Claude Code
install_link ".claude" "Claude Code"

# MimoCode (project-local convention)
install_link ".mimocode" "MimoCode"

# Codex / generic agents (.agents/)
install_link ".agents" "Codex/generic"

echo ""
if [ "$installed" -gt 0 ]; then
  echo "Done! Installed to $installed agent directory(ies)."
  echo "The skill will be available as /handoff in each agent."
  echo ""
  echo "Note: Add .opencode/skills/, .claude/skills/, .mimocode/skills/, .agents/skills/"
  echo "to your project's .gitignore if you don't want to track the symlinks."
else
  echo "No agent directories found."
fi

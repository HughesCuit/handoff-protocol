#!/bin/bash
# Uninstall handoff skill from project-local agent directories
# Usage: bash uninstall.sh [--project /path/to/project]
set -euo pipefail

PROJECT_DIR="${2:-.}"

if [ "${1:-}" = "--project" ] && [ -n "${2:-}" ]; then
  PROJECT_DIR="$2"
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo "Removing handoff skill from: $PROJECT_DIR"
echo ""

removed=0

remove_link() {
  local target="$PROJECT_DIR/$1/skills/handoff"
  if [ -L "$target" ]; then
    rm "$target"
    echo "  ✓ Removed symlink: $target"
    removed=$((removed + 1))
  elif [ -d "$target" ]; then
    rm -rf "$target"
    echo "  ✓ Removed directory: $target"
    removed=$((removed + 1))
  fi
}

remove_link ".opencode"
remove_link ".claude"
remove_link ".mimocode"
remove_link ".agents"

if [ "$removed" -gt 0 ]; then
  echo ""
  echo "Removed from $removed agent directory(ies)."
else
  echo "No handoff skill installations found."
fi

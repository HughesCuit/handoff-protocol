#!/bin/bash
# Install handoff-protocol skill for Codex
# Usage: bash install-codex.sh
set -euo pipefail

CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
INSTALLER="$CODEX_SKILLS_DIR/.system/skill-installer/scripts/install-skill-from-github.py"

if [ ! -f "$INSTALLER" ]; then
  echo "Error: Codex skill-installer not found at $INSTALLER"
  echo "Make sure Codex is installed and has been run at least once."
  exit 1
fi

echo "Installing handoff-protocol skill for Codex..."
python3 "$INSTALLER" --repo HughesCuit/handoff-protocol --path .

echo ""
echo "Done! Restart Codex to pick up the new skill."

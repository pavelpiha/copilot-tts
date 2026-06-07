#!/usr/bin/env bash
# Setup script for Copilot TTS on macOS
set -euo pipefail

echo "=== Copilot TTS — macOS setup ==="

# ── Verify afplay (built-in on macOS) ────────────────────────────────────────
if command -v afplay &>/dev/null; then
    echo "afplay found — audio playback is ready."
else
    echo "WARNING: afplay not found (unexpected on macOS). Audio may not play."
fi

# ── Node / npm check ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"

if command -v npm &>/dev/null; then
    echo ""
    echo "Installing Node.js dependencies…"
    (cd "$EXT_DIR" && npm install)
    echo "Compiling TypeScript…"
    (cd "$EXT_DIR" && npm run compile)
else
    echo "WARNING: npm not found. Install Node.js from https://nodejs.org and then run:"
    echo "  cd $EXT_DIR && npm install && npm run compile"
fi

echo ""
echo "=== Setup complete! ==="
echo ""
echo "The Supertonic 3 model (~500 MB) will be downloaded automatically"
echo "the first time you start the TTS server."
echo ""
echo "Open VS Code in this folder and press F5 to launch the extension."

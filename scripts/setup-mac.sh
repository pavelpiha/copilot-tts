#!/usr/bin/env bash
# Setup script for Copilot TTS on macOS
set -euo pipefail

echo "=== Copilot TTS — macOS setup ==="

# ── Python check ──────────────────────────────────────────────────────────────
PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" &>/dev/null; then
        VERSION=$("$candidate" --version 2>&1 | awk '{print $2}')
        MAJOR=$(echo "$VERSION" | cut -d. -f1)
        MINOR=$(echo "$VERSION" | cut -d. -f2)
        if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 9 ]; then
            PYTHON="$candidate"
            echo "Found Python $VERSION at $(command -v "$candidate")"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo ""
    echo "ERROR: Python 3.9+ not found."
    echo "Install via Homebrew:  brew install python3"
    echo "Or download from:      https://python.org/downloads/"
    exit 1
fi

# ── pip check ─────────────────────────────────────────────────────────────────
if ! "$PYTHON" -m pip --version &>/dev/null; then
    echo "ERROR: pip not found. Run:  $PYTHON -m ensurepip --upgrade"
    exit 1
fi

# ── Install Python dependencies ───────────────────────────────────────────────
echo ""
echo "Installing Python dependencies…"
"$PYTHON" -m pip install --upgrade supertonic fastapi "uvicorn[standard]"

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

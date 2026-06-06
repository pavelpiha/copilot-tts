#Requires -Version 5.1
<#
.SYNOPSIS
    Setup script for Copilot TTS on Windows.
.DESCRIPTION
    Verifies Python 3.9+, installs Python dependencies, and compiles
    the TypeScript extension source.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "=== Copilot TTS — Windows setup ===" -ForegroundColor Cyan

# ── Python check ──────────────────────────────────────────────────────────────
$python = $null
foreach ($candidate in @('python', 'python3', 'py')) {
    try {
        $ver = & $candidate --version 2>&1
        if ($ver -match 'Python (\d+)\.(\d+)') {
            $major = [int]$Matches[1]
            $minor = [int]$Matches[2]
            if ($major -ge 3 -and $minor -ge 9) {
                $python = $candidate
                Write-Host "Found $ver" -ForegroundColor Green
                break
            }
        }
    } catch { }
}

if (-not $python) {
    Write-Host ""
    Write-Host "ERROR: Python 3.9+ not found." -ForegroundColor Red
    Write-Host "Download from: https://python.org/downloads/"
    Write-Host "Make sure to tick 'Add Python to PATH' during installation."
    exit 1
}

# ── pip check ─────────────────────────────────────────────────────────────────
try {
    & $python -m pip --version | Out-Null
} catch {
    Write-Host "ERROR: pip not found. Run:  $python -m ensurepip --upgrade" -ForegroundColor Red
    exit 1
}

# ── Install Python dependencies ───────────────────────────────────────────────
Write-Host ""
Write-Host "Installing Python dependencies…" -ForegroundColor Yellow
& $python -m pip install --upgrade supertonic fastapi uvicorn

# ── Verify System.Media.SoundPlayer (built-in on Windows) ────────────────────
try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    Write-Host "System.Media.SoundPlayer available — audio playback is ready." -ForegroundColor Green
} catch {
    Write-Host "WARNING: Could not load System.Windows.Forms. Audio playback may fail." -ForegroundColor Yellow
}

# ── Node / npm check ─────────────────────────────────────────────────────────
$extDir = Split-Path -Parent $PSScriptRoot

$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
    Write-Host ""
    Write-Host "Installing Node.js dependencies…" -ForegroundColor Yellow
    Push-Location $extDir
    try {
        npm install
        Write-Host "Compiling TypeScript…" -ForegroundColor Yellow
        npm run compile
    } finally {
        Pop-Location
    }
} else {
    Write-Host ""
    Write-Host "WARNING: npm not found. Install Node.js from https://nodejs.org then run:" -ForegroundColor Yellow
    Write-Host "  cd `"$extDir`" && npm install && npm run compile"
}

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The Supertonic 3 model (~500 MB) will be downloaded automatically"
Write-Host "the first time you start the TTS server."
Write-Host ""
Write-Host "Open VS Code in this folder and press F5 to launch the extension."

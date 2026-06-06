#Requires -Version 5.1
<#
.SYNOPSIS
    Reset local Copilot TTS runtime state on Windows for clean-room testing.
.DESCRIPTION
    Removes extension runtime data (managed Python, venv, caches), optionally
    removes user-level uv installs/caches, resets settings changed by
    initialization, and can optionally uninstall the VS Code extension.
#>

param(
    [switch]$KeepUv,
    [switch]$KeepSettings,
    [switch]$RemoveExtension,
    [switch]$BestEffort
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Remove-PathIfExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathToRemove,
        [scriptblock]$BeforeRetry
    )

    if (Test-Path -LiteralPath $PathToRemove) {
        $maxAttempts = if ($BestEffort) { 5 } else { 3 }

        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
            try {
                Remove-Item -LiteralPath $PathToRemove -Recurse -Force -ErrorAction Stop
                Write-Host "Removed: $PathToRemove" -ForegroundColor Green
                return
            } catch {
                if ($attempt -lt $maxAttempts) {
                    if ($BeforeRetry) {
                        & $BeforeRetry
                    }
                    Start-Sleep -Milliseconds 750
                    continue
                }

                if ($BestEffort) {
                    Write-Host "Warning: failed to remove ${PathToRemove}: $($_.Exception.Message)" -ForegroundColor Yellow
                    return
                }

                throw
            }
        }
    } else {
        Write-Host "Skip (not found): $PathToRemove" -ForegroundColor DarkGray
    }
}

function Stop-CopilotTtsProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$RuntimeRoots
    )

    Write-Host "Stopping Copilot TTS runtime processes..." -ForegroundColor Yellow

    $normalizedRoots = $RuntimeRoots |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.TrimEnd('\\') }

    $candidates = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $exePath = $_.ExecutablePath
            $cmdLine = $_.CommandLine
            $matchesRuntimeRoot = $false

            foreach ($root in $normalizedRoots) {
                if ([string]::IsNullOrWhiteSpace($root)) {
                    continue
                }

                if (($exePath -and $exePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) -or
                    ($cmdLine -and $cmdLine.Contains($root))) {
                    $matchesRuntimeRoot = $true
                    break
                }
            }

            $matchesRuntimeRoot -or ($cmdLine -and $cmdLine.Contains('pavel-piha.copilot-tts'))
        }

    foreach ($proc in $candidates) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped process $($proc.ProcessId): $($proc.Name)" -ForegroundColor Green
        } catch {
            Write-Host "Warning: failed to stop process $($proc.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

function Remove-UvPythonLaunchers {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BinDir
    )

    if (-not (Test-Path -LiteralPath $BinDir)) {
        Write-Host "Skip launcher cleanup (not found): $BinDir" -ForegroundColor DarkGray
        return
    }

    $launcherPattern = '^(python|pythonw|python\d+(\.\d+){0,2}|pythonw\d+(\.\d+){0,2}|pypy|pypy\d+(\.\d+){0,2})\.exe$'
    $launchers = Get-ChildItem -LiteralPath $BinDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $launcherPattern }

    if (-not $launchers) {
        Write-Host "No uv Python launchers found in: $BinDir" -ForegroundColor DarkGray
        return
    }

    Write-Host "Removing uv Python launchers from: $BinDir" -ForegroundColor Yellow
    foreach ($launcher in $launchers) {
        Remove-PathIfExists -PathToRemove $launcher.FullName
    }
}

function Reset-CopilotTtsSettings {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SettingsPath
    )

    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        Write-Host "Skip settings reset (not found): $SettingsPath" -ForegroundColor DarkGray
        return
    }

    $raw = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8
    $updated = $raw

    # Remove settings written by initialization.
    $linePatterns = @(
        '(?m)^\s*"copilot-tts\.pythonPath"\s*:\s*"[^"]*"\s*,?\s*\r?\n',
        '(?m)^\s*"accessibility\.voice\.autoSynthesize"\s*:\s*true\s*,?\s*\r?\n'
    )

    foreach ($pattern in $linePatterns) {
        $updated = [regex]::Replace($updated, $pattern, '')
    }

    if ($updated -ne $raw) {
        Set-Content -LiteralPath $SettingsPath -Value $updated -Encoding UTF8
        Write-Host "Reset Copilot TTS initialization settings in: $SettingsPath" -ForegroundColor Green
    } else {
        Write-Host "No initialization settings found to reset in: $SettingsPath" -ForegroundColor DarkGray
    }
}

Write-Host "=== Copilot TTS - Windows clean ===" -ForegroundColor Cyan

$globalStorage = Join-Path $env:APPDATA 'Code\User\globalStorage\pavel-piha.copilot-tts'
$runtimeRoots = @(
    $globalStorage,
    (Join-Path $env:LOCALAPPDATA 'uv'),
    (Join-Path $env:USERPROFILE '.local\bin')
)

Stop-CopilotTtsProcesses -RuntimeRoots $runtimeRoots
Remove-PathIfExists -PathToRemove $globalStorage -BeforeRetry {
    Stop-CopilotTtsProcesses -RuntimeRoots $runtimeRoots
}

if (-not $KeepUv) {
    Write-Host ""
    Write-Host "Removing user-level uv install/cache..." -ForegroundColor Yellow
    Remove-UvPythonLaunchers -BinDir (Join-Path $env:USERPROFILE '.local\bin')

    $uvPaths = @(
        (Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
        (Join-Path $env:USERPROFILE '.local\bin\uvx.exe'),
        (Join-Path $env:USERPROFILE '.cache\uv'),
        (Join-Path $env:USERPROFILE '.local\share\uv'),
        (Join-Path $env:LOCALAPPDATA 'uv'),
        (Join-Path $env:APPDATA 'uv')
    )

    foreach ($target in $uvPaths) {
        Remove-PathIfExists -PathToRemove $target
    }
} else {
    Write-Host ""
    Write-Host "Keeping uv artifacts (--KeepUv)." -ForegroundColor Yellow
}

if (-not $KeepSettings) {
    Write-Host ""
    Write-Host "Resetting VS Code user settings changed by initialization..." -ForegroundColor Yellow
    $settingsPath = Join-Path $env:APPDATA 'Code\User\settings.json'
    Reset-CopilotTtsSettings -SettingsPath $settingsPath
} else {
    Write-Host ""
    Write-Host "Keeping VS Code user settings (--KeepSettings)." -ForegroundColor Yellow
}

if ($RemoveExtension) {
    Write-Host ""
    Write-Host "Uninstalling VS Code extension pavel-piha.copilot-tts..." -ForegroundColor Yellow
    $codeCmd = Get-Command code -ErrorAction SilentlyContinue
    if ($codeCmd) {
        try {
            & code --uninstall-extension pavel-piha.copilot-tts | Out-Host
        } catch {
            Write-Host "Warning: failed to uninstall extension via 'code' CLI: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "Skip uninstall: 'code' CLI is not available in PATH." -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "Keeping installed extension (default). Use --RemoveExtension to uninstall it too." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Clean complete ===" -ForegroundColor Cyan
Write-Host "Python aliases may still exist in WindowsApps (python/python3 stubs)."
Write-Host "Disable App execution aliases in Windows settings if you want those hidden too."

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import type { TtsService } from "./ttsService";
import { MANAGED_PYTHON_VERSION } from "./managedRuntime";
import { createManagedVenv } from "./managedRuntime";
import {
  type PythonCommandSpec,
  getConfiguredPythonCommand,
  getPythonCommandCandidates,
} from "./pythonRuntime";

/**
 * Full one-shot initializer triggered by "Copilot TTS: Initialize" command.
 *
 * Steps (with user confirmation):
 *   1. Detect platform and run the bundled setup script
 *      (bash setup-mac.sh on macOS/Linux, PowerShell setup-windows.ps1 on Windows)
 *   2. Start the TTS server
 */
export async function runInitialize(
  context: vscode.ExtensionContext,
  ttsService: TtsService,
  options?: {
    requireConfirmation?: boolean;
    source?: "command" | "chat-mode";
  },
): Promise<boolean> {
  const platform = os.platform();
  const requireConfirmation = options?.requireConfirmation ?? true;
  const source = options?.source ?? "command";

  // ── Confirmation modal ───────────────────────────────────────────────────
  if (requireConfirmation) {
    const choice = await vscode.window.showInformationMessage(
      "Copilot TTS - Initialize\n\nThis will:\n" +
        `  1. Download Python ^${MANAGED_PYTHON_VERSION} and install Python dependencies\n` +
        "  2. Download the TTS model (~500 MB) on first run\n" +
        "  3. Start the TTS server",
      { modal: true },
      "Continue",
    );
    if (choice !== "Continue") {
      return false;
    }
  }

  // ── Output channel (stays open so user can follow along) ─────────────────
  const out = vscode.window.createOutputChannel("Copilot TTS Setup");
  context.subscriptions.push(out);
  out.show(true);
  out.appendLine("=== Copilot TTS Initialization ===");
  if (source === "chat-mode") {
    out.appendLine("Triggered automatically while enabling TTS Chat Mode.\n");
  }
  out.appendLine(`Platform: ${platform}\n`);
  if (platform === "win32") {
    out.appendLine(
      'Note: VS Code/Node reports all Windows systems as "win32", including 64-bit Windows 11.\n',
    );
  }

  // ── Step 1: create venv + install deps ─────────────────────────────────
  out.appendLine("[ 1 / 2 ]  Installing Python dependencies…");
  try {
    const venvPython = await installDepsInVenv(context, platform, out);
    // Persist the venv Python path so ttsService and future runs use it
    await vscode.workspace
      .getConfiguration("copilot-tts")
      .update("pythonPath", venvPython, vscode.ConfigurationTarget.Global);
    out.appendLine(`\n✓  Dependencies installed. pythonPath → ${venvPython}\n`);
  } catch (err) {
    out.appendLine(`\n✗  Setup failed: ${err}`);
    vscode.window.showErrorMessage(
      `Copilot TTS setup failed — see "Copilot TTS Setup" output for details.`,
    );
    return false;
  }

  // ── Step 2: start TTS server ─────────────────────────────────────────────
  out.appendLine("[ 2 / 2 ]  Starting TTS server…");
  try {
    // Shut down any server that autoStart may have launched (possibly with
    // an old / wrong Python binary) so step 2 always starts fresh with the
    // venv Python that was just installed above.
    ttsService.shutdown();
    await new Promise((r) => setTimeout(r, 400)); // let the port release
    await ttsService.startServer(context, {
      progressChannel: out,
      showAlreadyRunningMessage: false,
      showReadyMessage: false,
    });
    out.appendLine("✓  TTS server is ready.\n");
  } catch (err) {
    out.appendLine(`\n✗  Server start failed: ${err}`);
    out.appendLine(
      '  → Fix the Python environment or inspect the "Copilot TTS Server" output channel, then retry.\n',
    );
    vscode.window.showErrorMessage(
      'Copilot TTS setup finished, but the local server did not start. See the "Copilot TTS Setup" output for details.',
    );
    return false;
  }

  out.appendLine("=== Initialization complete ===");

  vscode.window.showInformationMessage("Copilot TTS is ready.");

  return true;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Create (or reuse) a venv in the extension's global storage dir,
 * install supertonic + fastapi + uvicorn into it, and return the
 * path to the venv's Python binary.
 *
 * This avoids the PEP 668 "externally-managed-environment" error that
 * macOS Homebrew Python and many system Pythons produce for bare pip installs,
 * and falls back to an extension-managed Python runtime if no usable local
 * interpreter is present.
 */
async function installDepsInVenv(
  context: vscode.ExtensionContext,
  platform: NodeJS.Platform,
  out: vscode.OutputChannel,
): Promise<string> {
  const config = vscode.workspace.getConfiguration("copilot-tts");
  const configuredPython = config.get<string | undefined>("pythonPath");
  const debugLogging = config.get<boolean>("debug", false);

  // Storage dir is created by VS Code; we put the venv inside it
  const storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });
  const venvDir = path.join(storageDir, "venv");

  const isWin = platform === "win32";
  const venvPython = isWin
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
  const venvPip = isWin
    ? path.join(venvDir, "Scripts", "pip.exe")
    : path.join(venvDir, "bin", "pip");
  const bootstrapConfiguredPython = shouldIgnoreBootstrapPython(
    configuredPython,
    platform,
    venvDir,
  )
    ? undefined
    : configuredPython;
  const pythonCandidates = getPythonCommandCandidates(
    bootstrapConfiguredPython,
    platform,
  );

  if (bootstrapConfiguredPython === undefined && configuredPython?.trim()) {
    out.appendLine(
      `Ignoring stored copilot-tts.pythonPath for bootstrap because it points inside the managed venv: ${configuredPython}\n`,
    );
  }

  // ── Create venv (idempotent — skipped if python binary already exists) ──
  if (!fs.existsSync(venvPython)) {
    out.appendLine(`Creating venv at: ${venvDir}`);
    if (platform === "darwin") {
      // On macOS always use the managed runtime (uv + Python >3.14).
      // This avoids system Python (3.9), PEP 668 errors, and PATH issues.
      await createManagedVenv(context, platform, venvDir, out);
    } else {
      if (debugLogging) {
        out.appendLine(
          `Using base Python candidate${pythonCandidates.length === 1 ? "" : "s"}: ${pythonCandidates.map((candidate) => candidate.display).join(", ")}\n`,
        );
      } else {
        out.appendLine("Detecting local Python...\n");
      }
      try {
        await createVenv(venvDir, pythonCandidates, out, debugLogging);
      } catch (error) {
        const lastError =
          error instanceof Error ? error : new Error(String(error));
        if (debugLogging) {
          out.appendLine(
            `Falling back to a managed Python runtime because local venv creation failed: ${lastError.message}\n`,
          );
        } else {
          out.appendLine(
            "No usable local Python found. Falling back to a managed Python runtime.\n",
          );
        }
        await createManagedVenv(context, platform, venvDir, out);
      }
    }
  } else {
    out.appendLine(`Reusing existing venv: ${venvDir}\n`);
  }

  // ── Install / upgrade deps inside the venv ───────────────────────────────
  const deps = ["supertonic", "fastapi", "uvicorn"];
  out.appendLine(`Running: ${venvPip} install --upgrade ${deps.join(" ")}`);
  await runCommand(
    venvPip,
    ["install", "--upgrade", ...deps],
    out,
    getConfiguredPythonCommand(bootstrapConfiguredPython, platform).display,
  );

  return venvPython;
}

function shouldIgnoreBootstrapPython(
  configuredPython: string | undefined,
  platform: NodeJS.Platform,
  venvDir: string,
): boolean {
  const trimmed = configuredPython?.trim();
  if (!trimmed) {
    return false;
  }

  const configuredSpec = getConfiguredPythonCommand(trimmed, platform);
  if (configuredSpec.args.length > 0) {
    return false;
  }

  const normalizedConfiguredPath = path.resolve(configuredSpec.command);
  const normalizedVenvDir = path.resolve(venvDir);
  const pathPrefix = normalizedVenvDir.endsWith(path.sep)
    ? normalizedVenvDir
    : `${normalizedVenvDir}${path.sep}`;

  return platform === "win32"
    ? normalizedConfiguredPath
        .toLowerCase()
        .startsWith(pathPrefix.toLowerCase())
    : normalizedConfiguredPath.startsWith(pathPrefix);
}

async function createVenv(
  venvDir: string,
  candidates: readonly PythonCommandSpec[],
  out: vscode.OutputChannel,
  debugLogging: boolean,
): Promise<void> {
  let lastError: Error | undefined;

  for (const candidate of candidates) {
    if (debugLogging) {
      out.appendLine(`Trying: ${candidate.display} -m venv ${venvDir}`);
    }
    try {
      await runCommand(
        candidate.command,
        [...candidate.args, "-m", "venv", venvDir],
        out,
        candidate.display,
        { streamOutput: debugLogging },
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (debugLogging) {
        out.appendLine(`  -> failed with ${lastError.message}\n`);
      }
    }
  }

  throw (
    lastError ??
    new Error(
      "No usable Python launcher found. Set the copilot-tts.pythonPath setting to a Python 3.14+ executable.",
    )
  );
}

/** Spawn a command, pipe stdout/stderr to the output channel, resolve/reject on exit. */
function runCommand(
  cmd: string,
  args: string[],
  out: vscode.OutputChannel,
  pythonForErrorHint: string,
  options?: { streamOutput?: boolean },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { env: { ...process.env } });
    const streamOutput = options?.streamOutput ?? true;

    if (streamOutput) {
      proc.stdout?.on("data", (chunk: Buffer) => out.append(chunk.toString()));
      proc.stderr?.on("data", (chunk: Buffer) => out.append(chunk.toString()));
    }

    proc.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`"${cmd}" exited with code ${code}`));
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Executable not found: "${cmd}".\n` +
              `Make sure "${pythonForErrorHint}" is Python 3.14+ and in your PATH,\n` +
              'or update the "copilot-tts.pythonPath" setting.',
          ),
        );
      } else {
        reject(new Error(`Failed to launch "${cmd}": ${err.message}`));
      }
    });
  });
}

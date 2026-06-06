import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { existsSync } from "fs";
import * as vscode from "vscode";
import {
  getConfiguredPythonCommand,
  getPythonCommandCandidates,
} from "./pythonRuntime";
import { TtsService } from "./ttsService";
import { getManagedVenvPythonPath } from "./managedRuntime";

interface HookCommandConfig {
  type: "command";
  command: string;
}

interface HookMatcherConfig {
  matcher: string;
  hooks: HookCommandConfig[];
}

interface HookFileConfig {
  hooks: {
    Stop: HookMatcherConfig[];
  };
}

interface HookReplayState {
  sessionId?: string;
  vsCodeSessionId?: string;
  chatName?: string;
  text: string;
}

interface SessionReplayCacheEntry {
  text?: unknown;
  updatedAt?: unknown;
}

interface SessionReplayCacheFile {
  sessions?: Record<string, SessionReplayCacheEntry>;
}

interface SessionLabelCacheEntry {
  label?: unknown;
  updatedAt?: unknown;
}

interface SessionLabelCacheFile {
  sessions?: Record<string, SessionLabelCacheEntry>;
}

interface HookRuntimeSettings {
  port: number;
  voice: string;
  language: string;
  speed: number;
}

interface HookPlaybackState {
  stage: "synthesizing" | "playing";
  pid?: number;
  wavPath?: string;
}

export class TtsHookProvider implements vscode.Disposable {
  private readonly _hookFileUri: vscode.Uri;
  private readonly _hookLogUri: vscode.Uri;
  private readonly _hookStateDirUri: vscode.Uri;
  private readonly _lastResponseUri: vscode.Uri;
  private readonly _sessionReplayCacheUri: vscode.Uri;
  private readonly _sessionLabelCacheUri: vscode.Uri;
  private readonly _runtimeSettingsUri: vscode.Uri;
  private readonly _playbackStateUri: vscode.Uri;
  private readonly _hookLocationSettingPath: string;
  private readonly _sessionId = vscode.env.sessionId;
  private _enabled = false;
  private _hookPlaybackStage: "idle" | "synthesizing" | "playing" = "idle";
  private _playbackPoller: ReturnType<typeof setInterval> | undefined;
  private _lastObservedHookResponseMtimeMs = 0;
  private readonly _playbackStateEmitter = new vscode.EventEmitter<
    HookPlaybackState | undefined
  >();
  private readonly _hookResponseEmitter =
    new vscode.EventEmitter<HookReplayState>();
  private readonly _hookChangeListener: vscode.Disposable | undefined;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _ttsService: TtsService,
  ) {
    const storageRoot = _context.globalStorageUri;
    this._hookFileUri = vscode.Uri.joinPath(storageRoot, "tts-stop-hook.json");
    this._hookLogUri = vscode.Uri.joinPath(storageRoot, "tts-stop-hook.log");
    this._hookStateDirUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-stop-hook-state",
    );
    this._lastResponseUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-last-response.json",
    );
    this._sessionReplayCacheUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-session-responses.json",
    );
    this._sessionLabelCacheUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-session-labels.json",
    );
    this._runtimeSettingsUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-stop-hook-settings.json",
    );
    this._playbackStateUri = vscode.Uri.joinPath(
      storageRoot,
      "tts-stop-hook-playback.json",
    );
    this._hookLocationSettingPath = toHookLocationSettingPath(
      this._hookFileUri.fsPath,
    );

    const chatAny = vscode.chat as any;
    if (typeof chatAny.onDidChangeHooks === "function") {
      this._hookChangeListener = chatAny.onDidChangeHooks(() => {
        void this._logVisibleHooks("onDidChangeHooks event");
      });
    }

    this._ttsService.log(
      `[TTS hooks] using settings-based discovery hookFile=${this._hookFileUri.fsPath} settingKey=chat.hookFilesLocations settingEntry=${this._hookLocationSettingPath}`,
    );
    if (typeof chatAny.registerHookProvider === "function") {
      this._ttsService.log(
        "[TTS hooks] registerHookProvider API exists but this VS Code build does not enumerate hook providers; using chat.hookFilesLocations instead",
      );
    }
  }

  readonly onDidChangePlaybackState = this._playbackStateEmitter.event;
  readonly onDidReceiveHookResponse = this._hookResponseEmitter.event;

  async setEnabled(enabled: boolean): Promise<void> {
    if (this._enabled === enabled) {
      if (enabled) {
        await this.refreshConfiguration();
        await this._syncHookDiscoveryState("setEnabled(no-change)");
        await this._refreshPlaybackState();
      }
      return;
    }

    this._enabled = enabled;
    if (enabled) {
      this._startPlaybackPolling();
      await this._primeLastHookResponseTimestamp();
      await this.refreshConfiguration();
      await this._refreshPlaybackState();
      this._ttsService.log(
        `[TTS hooks] enabled Stop hook discovery logFile=${this._hookLogUri.fsPath}`,
      );
    } else {
      this._stopPlaybackPolling();
      this._updateObservedPlaybackState(undefined);
      this._lastObservedHookResponseMtimeMs = 0;
      this._ttsService.log("[TTS hooks] disabled Stop hook discovery");
    }
    await this._syncHookDiscoveryState("setEnabled");
  }

  async refreshConfiguration(): Promise<void> {
    if (!this._enabled) {
      return;
    }

    await fs.mkdir(this._context.globalStorageUri.fsPath, { recursive: true });
    await fs.mkdir(this._hookStateDirUri.fsPath, { recursive: true });

    // Write a per-workspace claim file so the hook script can derive the
    // correct vsCodeSessionId from the transcript path at runtime, even when
    // multiple VS Code windows share the same global hook file.
    const storageUri = this._context.storageUri;
    if (storageUri) {
      await fs.mkdir(storageUri.fsPath, { recursive: true });
      const claimPath = vscode.Uri.joinPath(
        storageUri,
        "tts-window-claim.json",
      ).fsPath;
      await fs.writeFile(
        claimPath,
        `${JSON.stringify({ vsCodeSessionId: this._sessionId })}\n`,
        "utf8",
      );
      this._ttsService.log(
        `[TTS hooks] wrote window claim vsCodeSessionId=${this._sessionId} to ${claimPath}`,
      );
    }

    const config = vscode.workspace.getConfiguration("copilot-tts");
    const configuredPython = config.get<string | undefined>("pythonPath");
    const python = this._resolveHookPython(configuredPython);
    const hookPython = isWindowsPythonExe(python.command)
      ? resolvePythonwSpec(python)
      : python;
    const port = config.get<number>("port", 8765);
    const voice = config.get<string>("voice", "M1");
    const language = config.get<string>("language", "en");
    const speed = config.get<number>("speed", 1);
    const runnerPath = path.join(
      this._context.extensionPath,
      "server",
      "hook_stop_tts.py",
    );
    const isWindows = os.platform() === "win32";

    const command = isWindows
      ? buildWindowsHookCommand({
          hookPython,
          runnerPath,
          hookStateDir: this._hookStateDirUri.fsPath,
          hookLogPath: this._hookLogUri.fsPath,
          lastResponsePath: this._lastResponseUri.fsPath,
          sessionCachePath: this._sessionReplayCacheUri.fsPath,
          sessionLabelsPath: this._sessionLabelCacheUri.fsPath,
          runtimeSettingsPath: this._runtimeSettingsUri.fsPath,
          playbackStatePath: this._playbackStateUri.fsPath,
          vsCodeSessionId: this._sessionId,
        })
      : [
          quoteForShell(hookPython.command),
          ...hookPython.args.map((arg) => quoteForShell(arg)),
          quoteForShell(runnerPath),
          "--log",
          quoteForShell(this._hookLogUri.fsPath),
          "--state-dir",
          quoteForShell(this._hookStateDirUri.fsPath),
          "--last-response-file",
          quoteForShell(this._lastResponseUri.fsPath),
          "--session-cache-file",
          quoteForShell(this._sessionReplayCacheUri.fsPath),
          "--session-labels-file",
          quoteForShell(this._sessionLabelCacheUri.fsPath),
          "--settings-file",
          quoteForShell(this._runtimeSettingsUri.fsPath),
          "--playback-state-file",
          quoteForShell(this._playbackStateUri.fsPath),
          "--vscode-session-id",
          quoteForShell(this._sessionId),
        ].join(" ");

    const runtimeSettings: HookRuntimeSettings = {
      port,
      voice,
      language,
      speed,
    };

    await fs.writeFile(
      this._runtimeSettingsUri.fsPath,
      `${JSON.stringify(runtimeSettings, null, 2)}\n`,
      "utf8",
    );

    const hookFile: HookFileConfig = {
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command,
              },
            ],
          },
        ],
      },
    };

    await fs.writeFile(
      this._hookFileUri.fsPath,
      `${JSON.stringify(hookFile, null, 2)}\n`,
      "utf8",
    );
    this._ttsService.log(
      `[TTS hooks] wrote Stop hook config hookFile=${this._hookFileUri.fsPath}`,
    );
    this._ttsService.debug(`[TTS hooks] hook command=${command}`);
    await this._syncHookDiscoveryState("refreshConfiguration");
  }

  private _resolveHookPython(
    configuredPython: string | undefined,
  ): ReturnType<typeof getConfiguredPythonCommand> {
    const trimmed = configuredPython?.trim();
    const managedVenvPython = getManagedVenvPythonPath(this._context);

    if (!trimmed) {
      if (managedVenvPython) {
        this._ttsService.log(
          `[TTS hooks] reusing managed Copilot TTS Python from ${managedVenvPython} for hook runner`,
        );
        return getConfiguredPythonCommand(managedVenvPython);
      }

      return getPythonCommandCandidates(undefined)[0];
    }

    const configuredSpec = getConfiguredPythonCommand(trimmed);
    const looksLikePath =
      configuredSpec.args.length === 0 &&
      (path.isAbsolute(configuredSpec.command) ||
        configuredSpec.command.includes("\\") ||
        configuredSpec.command.includes("/"));

    if (looksLikePath && !existsSync(configuredSpec.command)) {
      if (managedVenvPython) {
        this._ttsService.log(
          `[TTS hooks] Stored copilot-tts.pythonPath was not found (${configuredSpec.command}); reusing managed Copilot TTS Python from ${managedVenvPython} for hook runner`,
        );
        return getConfiguredPythonCommand(managedVenvPython);
      }

      this._ttsService.log(
        `[TTS hooks] Stored copilot-tts.pythonPath was not found (${configuredSpec.command}); using auto-detected Python command for hook runner`,
      );
      return getPythonCommandCandidates(undefined)[0];
    }

    return configuredSpec;
  }

  async logVisibleHooks(reason: string): Promise<void> {
    await this._logVisibleHooks(reason);
  }

  async loadLastHookResponse(): Promise<HookReplayState | undefined> {
    try {
      const raw = await fs.readFile(this._lastResponseUri.fsPath, "utf8");
      const parsed = JSON.parse(raw) as {
        sessionId?: unknown;
        vsCodeSessionId?: unknown;
        chatName?: unknown;
        text?: unknown;
      };
      if (typeof parsed.text !== "string") {
        return undefined;
      }

      const text = parsed.text.trim();
      if (!text) {
        return undefined;
      }

      return {
        sessionId:
          typeof parsed.sessionId === "string" && parsed.sessionId.trim()
            ? parsed.sessionId
            : undefined,
        vsCodeSessionId:
          typeof parsed.vsCodeSessionId === "string" &&
          parsed.vsCodeSessionId.trim()
            ? parsed.vsCodeSessionId
            : undefined,
        chatName:
          typeof parsed.chatName === "string" && parsed.chatName.trim()
            ? parsed.chatName.trim()
            : undefined,
        text,
      };
    } catch {
      return undefined;
    }
  }

  async loadHookResponseForSession(
    sessionKey: string,
  ): Promise<HookReplayState | undefined> {
    const sessionId = normalizeSessionKey(sessionKey);
    if (!sessionId) {
      return undefined;
    }

    const cache = await this._readSessionReplayCache();
    const entry = cache?.sessions?.[sessionId];
    if (!entry || typeof entry.text !== "string") {
      return undefined;
    }

    const text = entry.text.trim();
    if (!text) {
      return undefined;
    }

    return {
      sessionId,
      text,
    };
  }

  async setSessionLabel(sessionKey: string, label: string): Promise<void> {
    const sessionId = normalizeSessionKey(sessionKey);
    const cleaned = label.trim();
    if (!sessionId || !cleaned) {
      return;
    }

    const payload = await this._readSessionLabelCache();
    const sessions = payload.sessions ?? {};
    sessions[sessionId] = {
      label: cleaned,
      updatedAt: new Date().toISOString(),
    };

    payload.sessions = trimSessionCacheEntries(sessions);
    await fs.writeFile(
      this._sessionLabelCacheUri.fsPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }

  async stopPlayback(): Promise<boolean> {
    const state = await this._readPlaybackState();
    if (!state) {
      this._updateObservedPlaybackState(undefined);
      return false;
    }

    let stopped = false;
    if (typeof state.pid === "number") {
      try {
        process.kill(-state.pid, "SIGTERM");
        stopped = true;
        this._ttsService.log(
          `[TTS hooks] stopped auto playback processGroup=${state.pid}`,
        );
      } catch (error) {
        const groupMessage =
          error instanceof Error ? error.message : String(error);
        this._ttsService.log(
          `[TTS hooks] failed to stop auto playback processGroup=${state.pid}: ${groupMessage}`,
        );

        try {
          process.kill(state.pid, "SIGTERM");
          stopped = true;
          this._ttsService.log(
            `[TTS hooks] stopped auto playback pid=${state.pid}`,
          );
        } catch (fallbackError) {
          const message =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          this._ttsService.log(
            `[TTS hooks] failed to stop auto playback pid=${state.pid}: ${message}`,
          );
        }
      }
    } else {
      this._ttsService.log(
        `[TTS hooks] cancelled pending auto playback stage=${state.stage}`,
      );
      stopped = true;
    }

    if (state.wavPath) {
      try {
        await fs.rm(state.wavPath, { force: true });
      } catch {
        // Ignore cleanup failures; the temp file will be cleaned up later.
      }
    }

    await fs.rm(this._playbackStateUri.fsPath, { force: true });
    this._updateObservedPlaybackState(undefined);
    return stopped;
  }

  dispose(): void {
    this._stopPlaybackPolling();
    this._playbackStateEmitter.dispose();
    this._hookResponseEmitter.dispose();
    this._hookChangeListener?.dispose();
  }

  private async _syncHookDiscoveryState(reason: string): Promise<void> {
    if (this._enabled) {
      await this._ensureChatHooksEnabled();
      await this._updateHookLocationSetting(true, reason);
    } else {
      await this._updateHookLocationSetting(false, reason);
    }

    await this._logHookLocationSetting(reason);
    await this._logVisibleHooks(reason);
  }

  private async _readSessionLabelCache(): Promise<SessionLabelCacheFile> {
    try {
      const raw = await fs.readFile(this._sessionLabelCacheUri.fsPath, "utf8");
      const parsed = JSON.parse(raw) as SessionLabelCacheFile;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  private async _ensureChatHooksEnabled(): Promise<void> {
    const chatConfig = vscode.workspace.getConfiguration("chat");
    const useHooks = chatConfig.get<boolean>("useHooks");
    this._ttsService.log(
      `[TTS hooks] chat.useHooks current=${String(useHooks)}`,
    );

    if (useHooks === false) {
      await chatConfig.update(
        "useHooks",
        true,
        vscode.ConfigurationTarget.Global,
      );
      this._ttsService.log("[TTS hooks] set chat.useHooks=true");
    }
  }

  private async _updateHookLocationSetting(
    enabled: boolean,
    reason: string,
  ): Promise<void> {
    const chatConfig = vscode.workspace.getConfiguration("chat");
    const rawValue = chatConfig.get<Record<string, unknown> | undefined>(
      "hookFilesLocations",
    );
    const nextValue =
      rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
        ? { ...rawValue }
        : {};
    const hadEntry = Object.prototype.hasOwnProperty.call(
      nextValue,
      this._hookLocationSettingPath,
    );

    if (enabled) {
      nextValue[this._hookLocationSettingPath] = true;
    } else if (hadEntry) {
      delete nextValue[this._hookLocationSettingPath];
    } else {
      return;
    }

    const hasEntries = Object.keys(nextValue).length > 0;
    await chatConfig.update(
      "hookFilesLocations",
      hasEntries ? nextValue : undefined,
      vscode.ConfigurationTarget.Global,
    );

    this._ttsService.log(
      `[TTS hooks] ${reason}: ${enabled ? "registered" : "removed"} hook location settingEntry=${this._hookLocationSettingPath}`,
    );
  }

  private async _logHookLocationSetting(reason: string): Promise<void> {
    const rawValue = vscode.workspace
      .getConfiguration("chat")
      .get<unknown>("hookFilesLocations");
    this._ttsService.log(
      `[TTS hooks] ${reason}: chat.hookFilesLocations=${safeJson(rawValue)}`,
    );
  }

  private async _logVisibleHooks(reason: string): Promise<void> {
    const chatAny = vscode.chat as any;
    if (typeof chatAny.getHooks !== "function") {
      this._ttsService.log(
        `[TTS hooks] ${reason}: chat.getHooks is not available`,
      );
      return;
    }

    try {
      const tokenSource = new vscode.CancellationTokenSource();
      const hooks = await chatAny.getHooks(tokenSource.token);
      tokenSource.dispose();
      const summary = (
        hooks as Array<{
          uri?: vscode.Uri;
          sessionTypes?: readonly string[];
          source?: string;
        }>
      )
        .map((hook) => {
          const uri = hook.uri?.fsPath ?? String(hook.uri);
          const sessionTypes = hook.sessionTypes?.join(",") ?? "(none)";
          const source = hook.source ?? "(unknown)";
          return `${source}:${sessionTypes}:${uri}`;
        })
        .join(" | ");
      this._ttsService.log(
        `[TTS hooks] ${reason}: getHooks count=${hooks.length}${summary ? ` hooks=${summary}` : ""}`,
      );
    } catch (error) {
      this._ttsService.log(
        `[TTS hooks] ${reason}: getHooks failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async _readPlaybackState(): Promise<HookPlaybackState | undefined> {
    try {
      const raw = await fs.readFile(this._playbackStateUri.fsPath, "utf8");
      const parsed = JSON.parse(raw) as {
        stage?: unknown;
        pid?: unknown;
        wavPath?: unknown;
      };
      const stage =
        parsed.stage === "synthesizing" || parsed.stage === "playing"
          ? parsed.stage
          : typeof parsed.pid === "number" && Number.isFinite(parsed.pid)
            ? "playing"
            : undefined;
      if (!stage) {
        return undefined;
      }

      return {
        stage,
        pid:
          typeof parsed.pid === "number" && Number.isFinite(parsed.pid)
            ? parsed.pid
            : undefined,
        wavPath:
          typeof parsed.wavPath === "string" ? parsed.wavPath : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private async _readSessionReplayCache(): Promise<
    SessionReplayCacheFile | undefined
  > {
    try {
      const raw = await fs.readFile(this._sessionReplayCacheUri.fsPath, "utf8");
      return JSON.parse(raw) as SessionReplayCacheFile;
    } catch {
      return undefined;
    }
  }

  private _startPlaybackPolling(): void {
    if (this._playbackPoller) {
      return;
    }

    this._playbackPoller = setInterval(() => {
      void this._refreshPlaybackState();
    }, 250);
  }

  private _stopPlaybackPolling(): void {
    if (!this._playbackPoller) {
      return;
    }

    clearInterval(this._playbackPoller);
    this._playbackPoller = undefined;
  }

  private async _refreshPlaybackState(): Promise<void> {
    let state = await this._readPlaybackState();
    await this._refreshHookResponseSignal();

    if (
      state?.stage === "playing" &&
      typeof state.pid === "number" &&
      !isProcessAlive(state.pid)
    ) {
      this._ttsService.log(
        `[TTS hooks] playback process pid=${state.pid} is no longer running; clearing stale playback state`,
      );
      await fs.rm(this._playbackStateUri.fsPath, { force: true });
      state = undefined;
    }

    this._updateObservedPlaybackState(state);
  }

  private async _primeLastHookResponseTimestamp(): Promise<void> {
    try {
      const stat = await fs.stat(this._lastResponseUri.fsPath);
      this._lastObservedHookResponseMtimeMs = stat.mtimeMs;
    } catch {
      this._lastObservedHookResponseMtimeMs = 0;
    }
  }

  private async _refreshHookResponseSignal(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this._lastResponseUri.fsPath);
    } catch {
      return;
    }

    if (stat.mtimeMs <= this._lastObservedHookResponseMtimeMs) {
      return;
    }

    this._lastObservedHookResponseMtimeMs = stat.mtimeMs;

    const response = await this.loadLastHookResponse();
    if (!response) {
      return;
    }

    // Only play if this response was produced by the hook registered in THIS
    // VS Code window. Each window stamps its own vscode.env.sessionId into the
    // last-response file via --vscode-session-id.
    // - If the field is present and matches → play.
    // - If the field is present and doesn't match → skip (another window's response).
    // - If the field is absent or empty → skip: origin is unknown, playing in
    //   all windows simultaneously would cause duplicates.
    if (response.vsCodeSessionId !== this._sessionId) {
      this._ttsService.log(
        `[TTS hooks] skipping – response vsCodeSessionId=${String(response.vsCodeSessionId ?? "(missing)")} this=${this._sessionId}`,
      );
      return;
    }

    this._ttsService.log(
      `[TTS hooks] detected new hook response chars=${response.text.length} session=${response.sessionId ?? "(unknown)"}`,
    );
    this._hookResponseEmitter.fire(response);
  }

  private _updateObservedPlaybackState(
    state: HookPlaybackState | undefined,
  ): void {
    const stage = state?.stage ?? "idle";
    if (this._hookPlaybackStage === stage) {
      return;
    }

    this._hookPlaybackStage = stage;
    this._ttsService.log(`[TTS hooks] auto playback state stage=${stage}`);
    this._playbackStateEmitter.fire(state);
  }
}

function isWindowsPythonExe(command: string): boolean {
  return process.platform === "win32" && /python\.exe$/i.test(command);
}

function resolvePythonwSpec(
  spec: ReturnType<typeof getConfiguredPythonCommand>,
): ReturnType<typeof getConfiguredPythonCommand> {
  if (spec.args.length > 0) {
    return spec;
  }

  const pythonw = spec.command.replace(/python\.exe$/i, "pythonw.exe");
  if (!existsSync(pythonw)) {
    return spec;
  }

  return {
    command: pythonw,
    args: [],
    display: pythonw,
  };
}

function buildWindowsHookCommand(options: {
  hookPython: ReturnType<typeof getConfiguredPythonCommand>;
  runnerPath: string;
  hookStateDir: string;
  hookLogPath: string;
  lastResponsePath: string;
  sessionCachePath: string;
  sessionLabelsPath: string;
  runtimeSettingsPath: string;
  playbackStatePath: string;
  vsCodeSessionId: string;
}): string {
  const argumentList = [
    ...options.hookPython.args,
    options.runnerPath,
    "--payload-file",
    "$payloadFile",
    "--log",
    options.hookLogPath,
    "--state-dir",
    options.hookStateDir,
    "--last-response-file",
    options.lastResponsePath,
    "--session-cache-file",
    options.sessionCachePath,
    "--session-labels-file",
    options.sessionLabelsPath,
    "--settings-file",
    options.runtimeSettingsPath,
    "--playback-state-file",
    options.playbackStatePath,
    "--vscode-session-id",
    options.vsCodeSessionId,
  ]
    .map((value) =>
      value === "$payloadFile" ? value : `'${value.replace(/'/g, "''")}'`,
    )
    .join(", ");

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Console]::In.ReadToEnd()`,
    `$payloadFile = Join-Path '${options.hookStateDir.replace(/'/g, "''")}' ('payload-' + [guid]::NewGuid().ToString() + '.json')`,
    `[System.IO.Directory]::CreateDirectory('${options.hookStateDir.replace(/'/g, "''")}') | Out-Null`,
    `[System.IO.File]::WriteAllText($payloadFile, $payload, [System.Text.UTF8Encoding]::new($false))`,
    `$argumentList = @(${argumentList})`,
    `Start-Process -FilePath '${options.hookPython.command.replace(/'/g, "''")}' -ArgumentList $argumentList -WindowStyle Hidden`,
  ].join("; ");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");

  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand,
  ].join(" ");
}

function quoteForShell(value: string): string {
  if (os.platform() === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function trimSessionCacheEntries<T extends { updatedAt?: unknown }>(
  sessions: Record<string, T>,
): Record<string, T> {
  const entries = Object.entries(sessions);
  if (entries.length <= 50) {
    return sessions;
  }

  return Object.fromEntries(
    entries
      .sort(([, left], [, right]) =>
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        ),
      )
      .slice(0, 50),
  );
}

function toHookLocationSettingPath(filePath: string): string {
  const homeDir = os.homedir();
  const relativeToHome = path.relative(homeDir, filePath);
  if (
    relativeToHome &&
    relativeToHome !== "" &&
    !relativeToHome.startsWith("..") &&
    !path.isAbsolute(relativeToHome)
  ) {
    return `~/${relativeToHome.split(path.sep).join("/")}`;
  }
  return filePath;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeSessionKey(sessionKey: string): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith("sid:") ? trimmed.slice(4) : trimmed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission to signal it.
    return code === "EPERM";
  }
}

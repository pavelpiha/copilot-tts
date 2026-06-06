import * as vscode from "vscode";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { ChildProcess, spawn } from "child_process";
import { AudioPlayer } from "./audioPlayer";
import {
  getConfiguredPythonCommand,
  getPythonCommandCandidates,
  type PythonCommandSpec,
} from "./pythonRuntime";
import { getManagedVenvPythonPath } from "./managedRuntime";
import { stripMarkdown, chunkText } from "./textUtils";
import type { TtsControlPanelProvider } from "./ttsControlPanel";

interface SynthesisResult {
  buffer: Buffer;
  duration: number;
}

interface QueuedItem {
  text: string;
  chatName: string;
}

/**
 * Extract the chat label from text that was prefixed by hook_stop_tts.py's
 * prefix_with_chat_name(): "Chat: <name>. <body>" or "Chat: <name> <body>"
 * (the trailing separator is ". " unless the name already ends in punctuation).
 */
function parseChatNameFromPrefixedText(text: string): string {
  const m = text.match(/^Chat:\s+(.+?)(?:\.\s|\s(?=[A-Z]))/);
  return m ? m[1].trim() : "";
}

const SERVER_STARTUP_MAX_WAIT_MS = 5 * 60_000;
/** How long a cross-window playback lock is valid before it is considered stale. */
const PLAYBACK_LOCK_STALE_MS = 5 * 60_000;

export class TtsService {
  private serverProcess: ChildProcess | undefined;
  private _isReady = false;
  private _isStopped = false;
  private _isStreamingActive = false;
  private _chatModeEnabled = false;

  /** Pipelined queue: synthesis fires immediately, playback awaits in order. */
  private playbackQueue: Promise<SynthesisResult | null>[] = [];
  private playbackLoopPromise: Promise<void> = Promise.resolve();
  private playbackRunning = false;

  /** Manual-speak queue: items waiting to be played one after another. */
  private _manualQueue: QueuedItem[] = [];
  private _speakLoopPromise: Promise<void> = Promise.resolve();
  private _speakLoopRunning = false;
  private _currentlyPlayingItem: QueuedItem | undefined;
  private _wakeRunLoop: (() => void) | undefined;
  private _lockWaitAbort: AbortController | undefined;

  /** Cross-window playback lock file path (set via setGlobalStorageUri). */
  private _playbackLockPath: string | undefined;
  private readonly _vsCodeSessionId = vscode.env.sessionId;

  private _lastResponseText = "";
  private _lastResponseChatName = "";
  private _cleanedTextBuffer = "";
  private _activeSessionId = 0;
  /** Per-chat text store: sessionKey → last cleaned response. */
  private _chatTexts = new Map<string, string>();
  private _statusBar: vscode.StatusBarItem | undefined;
  private _speedBar: vscode.StatusBarItem | undefined;
  private _outputChannel: vscode.OutputChannel | undefined;
  private _controlPanel: TtsControlPanelProvider | undefined;
  private _synthErrorShown = false;
  private _debug = false;

  currentSpeed = 1.0;

  constructor(private readonly audioPlayer: AudioPlayer) {}

  get isReady(): boolean {
    return this._isReady;
  }

  get chatModeEnabled(): boolean {
    return this._chatModeEnabled;
  }

  setChatModeEnabled(enabled: boolean): void {
    this._chatModeEnabled = enabled;
    this.log(`[TTS mode] chatModeEnabled=${enabled}`);
  }

  setStatusBar(item: vscode.StatusBarItem): void {
    this._statusBar = item;
  }
  setOutputChannel(channel: vscode.OutputChannel): void {
    this._outputChannel = channel;
  }
  setDebug(enabled: boolean): void {
    this._debug = enabled;
  }
  /** Always-visible INFO line (server start/stop, errors). */
  log(message: string): void {
    if (message.startsWith("[TTS")) {
      this.debug(message);
      return;
    }
    this._outputChannel?.appendLine(message);
  }
  /** Debug-only line — suppressed unless copilot-tts.debug is true. */
  debug(message: string): void {
    if (this._debug) {
      this._outputChannel?.appendLine(message);
    }
  }
  setSpeedBar(item: vscode.StatusBarItem): void {
    this._speedBar = item;
  }
  setGlobalStorageUri(uri: vscode.Uri): void {
    this._playbackLockPath = path.join(uri.fsPath, "tts-playback-lock.json");
  }
  setControlPanel(panel: TtsControlPanelProvider): void {
    this._controlPanel = panel;
    this._controlPanel.setReplayAvailable(
      Boolean(this._lastResponseText.trim()),
    );
    this._notifyQueue();
  }
  getLastResponseText(): string {
    return this._lastResponseText;
  }

  getLastResponseChatName(): string {
    return this._lastResponseChatName;
  }

  /** @internal */ _setLastResponseText(text: string): void {
    this._setReplayText(text);
  }

  rememberHookResponse(text: string, sessionId?: string, chatName = ""): void {
    const cleaned = text.trim();
    if (!cleaned) {
      return;
    }

    this._setReplayText(cleaned);
    this._lastResponseChatName = chatName;
    if (sessionId) {
      this._chatTexts.set(sessionId, cleaned);
      this._chatTexts.set(`sid:${sessionId}`, cleaned);
    }
  }

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    vscode.workspace
      .getConfiguration("copilot-tts")
      .update("speed", speed, vscode.ConfigurationTarget.Global);
    this._controlPanel?.setSpeed(speed);
    if (this._speedBar) {
      const label = speed % 1 === 0 ? String(Math.round(speed)) : String(speed);
      this._speedBar.text = `$(dashboard) ${label}×`;
    }
  }

  // ── Playback preparation ──────────────────────────────────────────────────

  _enqueueText(text: string, sessionId: number): void {
    if (this._isStopped || sessionId !== this._activeSessionId) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("copilot-tts");
    const voice = cfg.get<string>("voice", "M1");
    const lang = cfg.get<string>("language", "en");
    const port = cfg.get<number>("port", 8765);
    const readCodeBlocks = cfg.get<boolean>("readCodeBlocks", false);

    const cleaned = stripMarkdown(text, readCodeBlocks);
    if (!cleaned.trim()) {
      return;
    }
    // Accumulate the cleaned text — this becomes _lastResponseText at session end
    // so Play always replays exactly what was spoken (not raw markdown).
    this._cleanedTextBuffer +=
      (this._cleanedTextBuffer ? " " : "") + cleaned.trim();

    for (const chunk of chunkText(cleaned)) {
      if (!chunk.trim()) {
        continue;
      }
      this.debug(
        `[TTS send] voice=${voice} lang=${lang} speed=${this.currentSpeed} | ${chunk}`,
      );
      const p = this.synthesize(
        chunk,
        voice,
        lang,
        port,
        this.currentSpeed,
      ).catch((err: Error) => {
        this.log(`[ERROR] TTS synthesis failed: ${err.message}`);
        // Show a notification once per session so the user knows something failed
        if (!this._synthErrorShown) {
          this._synthErrorShown = true;
          // Auto-reveal the output channel so the user can see the server log
          this._outputChannel?.show(true);
          vscode.window.showWarningMessage(
            `Copilot TTS: synthesis failed (“${err.message}”). ` +
              'See the "Copilot TTS Server" output channel for details.',
          );
        }
        return null;
      });
      this.playbackQueue.push(p);
      this._wakeRunLoop?.();
      this._wakeRunLoop = undefined;
    }

    if (!this.playbackRunning) {
      this.playbackLoopPromise = this._runLoop();
    }
  }

  _markSessionEnd(sessionId: number, chatFingerprint?: string): void {
    if (sessionId !== this._activeSessionId) {
      return;
    }
    this._isStreamingActive = false;
    this._wakeRunLoop?.();
    this._wakeRunLoop = undefined;
    const text = this._cleanedTextBuffer.trim();
    if (text) {
      this._setReplayText(text);
      if (chatFingerprint) {
        this._chatTexts.set(chatFingerprint, text);
        this.debug(
          `[TTS session] saved ${text.length} chars for key: ${chatFingerprint}`,
        );
      }
    }
  }

  /**
   * Called when VS Code fires onDidChangeActiveChatPanelSessionResource.
   * The sessionKey comes from (request as any).sessionId which Copilot puts on
   * every ChatRequest and which matches the last path-segment of the resource URI.
   * Restores _lastResponseText so the Play button replays the correct chat.
   */
  restoreSession(sessionKey: string): void {
    if (this._isStreamingActive) {
      return;
    }
    const stored = this._chatTexts.get(sessionKey);
    if (stored !== undefined) {
      this._setReplayText(stored);
      this.debug(
        `[TTS session switch] restored ${stored.length} chars for key=${sessionKey}`,
      );
    } else {
      this._setReplayText("");
      this.debug(
        `[TTS session switch] no stored text for key=${sessionKey}, Play cleared`,
      );
    }
  }

  // ── One-shot speak ────────────────────────────────────────────────────────

  /**
   * Enqueue `text` for playback.
   *
   * - Same window: if audio is already playing the text is appended to the
   *   manual queue and played automatically when the current item finishes.
   *   Nothing is interrupted.
   * - Cross-window: each window writes a playback-lock file stamped with its
   *   own VS Code session ID.  Before starting audio the draining loop waits
   *   until the lock belongs to this window (or is stale) so two windows never
   *   play audio through the system speaker at the same time.
   */
  async speak(text: string, chatName = ""): Promise<void> {
    if (!this._isReady) {
      vscode.window.showWarningMessage(
        'Copilot TTS: server not running. Use "Copilot TTS: Start Server".',
      );
      return;
    }

    // Deduplicate: ignore if the same text is already playing or queued.
    const resolvedName = chatName || parseChatNameFromPrefixedText(text);
    const alreadyPresent =
      this._currentlyPlayingItem?.text === text ||
      this._manualQueue.some((item) => item.text === text);
    if (alreadyPresent) {
      this.log(
        `[TTS queue] skipping duplicate chatName="${resolvedName}" – already in queue`,
      );
      return;
    }

    this._manualQueue.push({ text, chatName: resolvedName });
    this.log(
      `[TTS queue] enqueued chatName="${resolvedName}" queue=${this._manualQueue.length}`,
    );
    this._notifyQueue();

    if (!this._speakLoopRunning) {
      this._speakLoopPromise = this._drainSpeakQueue();
    }
    await this._speakLoopPromise;
  }

  private async _drainSpeakQueue(): Promise<void> {
    if (this._speakLoopRunning) {
      return;
    }
    this._speakLoopRunning = true;
    // Keep Play disabled and Stop enabled for the entire lifetime of the loop
    // (covers both the lock-wait phase and the actual audio phase).
    this._controlPanel?.setPlaybackState(true);

    try {
      while (this._manualQueue.length > 0) {
        if (this._isStopped) {
          // stopSpeaking() already snapshot-cleared the queue.
          // Reset flag and continue if new items arrived after the stop.
          this._isStopped = false;
          this._currentlyPlayingItem = undefined;
          this._notifyQueue();
          continue;
        }

        const item = this._manualQueue.shift()!;
        this._currentlyPlayingItem = item;
        this._notifyQueue();

        // Cross-window: wait until this window owns the playback lock.
        await this._acquirePlaybackLock();

        if (this._isStopped) {
          this._isStopped = false;
          this._currentlyPlayingItem = undefined;
          await this._releasePlaybackLock();
          this._notifyQueue();
          continue;
        }

        try {
          await this._playSingle(item.text);
        } finally {
          this._currentlyPlayingItem = undefined;
          await this._releasePlaybackLock();
          this._notifyQueue();
        }
      }
    } finally {
      this._speakLoopRunning = false;
      this._isStopped = false;
      this._currentlyPlayingItem = undefined;
      this._notifyQueue();
      this._controlPanel?.setPlaybackState(false);
      this._updateStatus("$(unmute) TTS: ready", false);
    }
  }

  private async _playSingle(text: string): Promise<void> {
    this._isStopped = false;
    this._isStreamingActive = true;
    this._synthErrorShown = false;
    this._cleanedTextBuffer = "";
    this.playbackQueue = [];
    const id = ++this._activeSessionId;
    this._setReplayText(text);
    this._updateStatus("$(sync~spin) TTS: synthesizing…", true);
    this._enqueueText(text, id);
    this._markSessionEnd(id);
    await this.playbackLoopPromise;
  }

  // ── Cross-window playback lock ────────────────────────────────────────────

  /** Push current queue state to the control panel WebView. */
  private _notifyQueue(): void {
    if (!this._controlPanel) {
      return;
    }
    const items: Array<{ chatName: string; playing: boolean }> = [];
    if (this._currentlyPlayingItem) {
      items.push({
        chatName: this._currentlyPlayingItem.chatName,
        playing: true,
      });
    }
    for (const item of this._manualQueue) {
      items.push({ chatName: item.chatName, playing: false });
    }
    this._controlPanel.setQueue(items);
  }

  private async _acquirePlaybackLock(): Promise<void> {
    if (!this._playbackLockPath) {
      return; // No lock path configured — single-instance mode, skip.
    }
    while (!this._isStopped) {
      // Evict any expired lock before attempting to claim.
      await this._evictStaleLockIfExpired();
      if (this._isStopped) return;

      if (await this._tryWriteLockExclusive()) return;

      // Another window holds the lock — watch the parent directory for a
      // rename event (deletion) and retry once it fires.
      this.log(`[TTS lock] waiting for another window to finish…`);
      this._updateStatus(
        "$(sync~spin) TTS: waiting for another window…",
        true,
        true,
      );
      await this._waitForLockRelease();
    }
  }

  /** Deletes the lock file if its `expiresAt` timestamp has passed. */
  private async _evictStaleLockIfExpired(): Promise<void> {
    if (!this._playbackLockPath) return;
    try {
      const raw = await fsPromises.readFile(this._playbackLockPath, "utf8");
      const data = JSON.parse(raw) as {
        sessionId?: string;
        expiresAt?: number;
      };
      if (typeof data.expiresAt === "number" && Date.now() > data.expiresAt) {
        await fsPromises.rm(this._playbackLockPath, { force: true });
        this.debug(
          `[TTS lock] evicted stale lock from ${String(data.sessionId)}`,
        );
      }
    } catch {
      // Lock absent or unreadable — nothing to evict.
    }
  }

  /**
   * Watches the lock file's parent directory for a `rename` event (which
   * Node.js fires on both creation and deletion) and resolves when the lock
   * file disappears.  Also resolves immediately if the file is already gone —
   * closing the race between `_tryWriteLockExclusive` returning false and the
   * watch being set up.  Resolves early when `stopSpeaking` aborts the wait.
   */
  private _waitForLockRelease(): Promise<void> {
    const lockPath = this._playbackLockPath!;
    const lockDir = path.dirname(lockPath);
    const lockFile = path.basename(lockPath);
    const abortCtrl = new AbortController();
    this._lockWaitAbort = abortCtrl;

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this._lockWaitAbort = undefined;
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        resolve();
      };

      abortCtrl.signal.addEventListener("abort", done, { once: true });

      const watcher = fs.watch(lockDir, (_event, filename) => {
        if (filename === lockFile) done();
      });
      watcher.once("error", done);

      // Handle the race: if the lock was deleted between the failed
      // _tryWriteLockExclusive call and this watch setup, wake up immediately.
      void fsPromises.access(lockPath).catch(done);
    });
  }

  /**
   * Atomically create the lock file using O_EXCL (exclusive-create).
   * Returns true if this window now owns the lock, false if another window
   * beat us to it (EEXIST). Any other error is treated as success (non-fatal).
   */
  private async _tryWriteLockExclusive(): Promise<boolean> {
    if (!this._playbackLockPath) {
      return true;
    }
    try {
      await fsPromises.mkdir(path.dirname(this._playbackLockPath), {
        recursive: true,
      });
      const fd = await fsPromises.open(this._playbackLockPath, "wx"); // O_EXCL
      try {
        await fd.writeFile(
          JSON.stringify({
            sessionId: this._vsCodeSessionId,
            expiresAt: Date.now() + PLAYBACK_LOCK_STALE_MS,
          }),
          "utf8",
        );
      } finally {
        await fd.close();
      }
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return false; // another window won the race
      }
      // Any other FS error: non-fatal, allow playback.
      return true;
    }
  }

  private async _releasePlaybackLock(): Promise<void> {
    if (!this._playbackLockPath) {
      return;
    }
    try {
      const raw = await fsPromises.readFile(this._playbackLockPath, "utf8");
      const data = JSON.parse(raw) as { sessionId?: unknown };
      if (data.sessionId === this._vsCodeSessionId) {
        await fsPromises.rm(this._playbackLockPath, { force: true });
      }
    } catch {
      // Ignore.
    }
  }

  stopSpeaking(): void {
    // Snapshot clear: remove items currently in the queue.
    // Items pushed after this call (e.g. from the hook poller) survive and
    // will continue playing once the stop is processed.
    this._manualQueue.splice(0, this._manualQueue.length);
    this._currentlyPlayingItem = undefined;
    this._isStopped = true;
    this._isStreamingActive = false;
    this.playbackQueue = [];
    this._lockWaitAbort?.abort();
    this._lockWaitAbort = undefined;
    this._wakeRunLoop?.();
    this._wakeRunLoop = undefined;
    this.audioPlayer.stop();
    void this._releasePlaybackLock();
    this._updateStatus("$(unmute) TTS: ready", false);
    this._notifyQueue();
  }

  clearLastResponseText(): void {
    this._setReplayText("");
  }

  // ── Playback loop ─────────────────────────────────────────────────────────

  private async _runLoop(): Promise<void> {
    if (this.playbackRunning) {
      return;
    }
    this.playbackRunning = true;

    while (!this._isStopped) {
      if (this.playbackQueue.length === 0) {
        if (!this._isStreamingActive) {
          break;
        }
        await new Promise<void>((resolve) => {
          this._wakeRunLoop = resolve;
        });
        continue;
      }
      const resultPromise = this.playbackQueue.shift()!;
      const result = await resultPromise;
      if (result && !this._isStopped) {
        this._updateStatus("$(unmute) TTS: playing…", false);
        try {
          await this.audioPlayer.play(
            result.buffer,
            this.currentSpeed,
            result.duration,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.log(`[ERROR] Local audio playback failed: ${message}`);
          this._outputChannel?.show(true);
          vscode.window.showWarningMessage(
            `Copilot TTS: local playback failed (${message}). See the "Copilot TTS Server" output channel for details.`,
          );
          this._updateStatus("$(mute) TTS: audio error", false);
          break;
        }
      }
    }

    this.playbackRunning = false;
    // Only announce "ready" if the manual-speak drain loop is NOT still
    // running.  When processing a queue of items, _runLoop() fires once per
    // item; emitting "ready" between items briefly disables Stop and clears
    // the panel's playing state, which confuses the queue display and the
    // webview state re-sent on panel re-open.
    if (!this._isStopped && !this._speakLoopRunning) {
      this._updateStatus("$(unmute) TTS: ready", false);
    }
  }

  // ── Status helpers ────────────────────────────────────────────────────────

  private _updateStatus(
    barText: string,
    spinning: boolean,
    forcePlayingState?: boolean,
  ): void {
    if (this._statusBar) {
      this._statusBar.text = barText;
    }
    const label = barText.replace(/\$\([^)]+\)\s*/g, "");
    const playing =
      forcePlayingState !== undefined
        ? forcePlayingState
        : label.includes("synthesizing") || label.includes("playing");
    this._controlPanel?.setStatus(label, spinning, playing);
  }

  private _setReplayText(text: string): void {
    this._lastResponseText = text;
    this._controlPanel?.setReplayAvailable(Boolean(text.trim()));
  }

  // ── Server lifecycle ──────────────────────────────────────────────────────

  async startServer(
    context: vscode.ExtensionContext,
    options?: {
      progressChannel?: vscode.OutputChannel;
      showAlreadyRunningMessage?: boolean;
      showReadyMessage?: boolean;
    },
  ): Promise<void> {
    if (this.serverProcess && !this.serverProcess.killed) {
      if (options?.showAlreadyRunningMessage !== false) {
        vscode.window.showInformationMessage(
          "Copilot TTS server is already running.",
        );
      }
      return;
    }

    const cfg = vscode.workspace.getConfiguration("copilot-tts");
    const configuredPython = cfg.get<string | undefined>("pythonPath");
    const pythonCandidates = this._getPythonStartupCandidates(
      context,
      configuredPython,
    );
    const port = cfg.get<number>("port", 8765);
    const serverScript = path.join(
      context.extensionPath,
      "server",
      "tts_server.py",
    );

    if (await this._reuseHealthyServer(port)) {
      return;
    }

    this._updateStatus("$(sync~spin) TTS: starting…", true);
    const startupErrors: string[] = [];

    for (const python of pythonCandidates) {
      this.log(
        `[INFO] Starting local TTS server with ${python.display} on 127.0.0.1:${port}`,
      );
      const serverProcess = spawn(
        python.command,
        [...python.args, serverScript, "--port", String(port)],
        {
          env: this._buildServerEnvironment(context),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Output channel is created at activation time and passed in via
      // setOutputChannel() — we just alias it here for the server log listeners.
      const outputChannel = this._outputChannel;
      const progressChannel = options?.progressChannel;
      serverProcess.stdout?.on("data", (d: Buffer) =>
        this._appendServerOutput(d, outputChannel, progressChannel),
      );
      serverProcess.stderr?.on("data", (d: Buffer) =>
        this._appendServerOutput(d, outputChannel, progressChannel),
      );
      serverProcess.on("spawn", () => {
        outputChannel?.appendLine(
          `[INFO] Spawned local TTS server process pid=${serverProcess.pid ?? "unknown"}`,
        );
      });

      this.serverProcess = serverProcess;

      try {
        await this.waitForServerOrExit(
          serverProcess,
          port,
          SERVER_STARTUP_MAX_WAIT_MS,
        );
        this.serverProcess.on("close", (code) => {
          void this._handleServerExit(code, port);
        });
        this._isReady = true;
        this._updateStatus("$(unmute) TTS: ready", false);
        if (options?.showReadyMessage !== false) {
          vscode.window.showInformationMessage("Copilot TTS server is ready");
        }
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        startupErrors.push(`${python.display}: ${message}`);
        this.log(
          `[WARN] Failed to start TTS server with ${python.display}: ${message}`,
        );

        if (!serverProcess.killed) {
          try {
            serverProcess.kill();
          } catch {
            // ignore process termination failures during startup fallback
          }
        }

        if (this.serverProcess === serverProcess) {
          this.serverProcess = undefined;
        }
      }
    }

    this._isReady = false;
    this._updateStatus("$(mute) TTS: error", false);
    throw new Error(
      `Unable to start Copilot TTS server. Tried: ${startupErrors.join(" | ")}`,
    );
  }

  private _appendServerOutput(
    chunk: Buffer,
    outputChannel: vscode.OutputChannel | undefined,
    progressChannel: vscode.OutputChannel | undefined,
  ): void {
    const text = chunk.toString();
    outputChannel?.append(text);
    if (progressChannel && progressChannel !== outputChannel) {
      progressChannel.append(text);
    }
  }

  shutdown(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      try {
        this.serverProcess.kill();
      } catch {
        /* ignore */
      }
    }
    this._isReady = false;
    this.serverProcess = undefined;
    this._updateStatus("$(mute) TTS: stopped", false);
  }

  private _buildServerEnvironment(
    context: vscode.ExtensionContext,
  ): NodeJS.ProcessEnv {
    const runtimeRoot = path.join(context.globalStorageUri.fsPath, "runtime");
    const xdgCacheHome = path.join(runtimeRoot, "xdg-cache");
    const hfHome = path.join(runtimeRoot, "hf-home");
    const huggingFaceHubCache = path.join(hfHome, "hub");
    const transformersCache = path.join(hfHome, "transformers");

    for (const dir of [
      runtimeRoot,
      xdgCacheHome,
      hfHome,
      huggingFaceHubCache,
      transformersCache,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return {
      ...process.env,
      XDG_CACHE_HOME: xdgCacheHome,
      HF_HOME: hfHome,
      HUGGINGFACE_HUB_CACHE: huggingFaceHubCache,
      TRANSFORMERS_CACHE: transformersCache,
    };
  }

  private async _reuseHealthyServer(port: number): Promise<boolean> {
    const healthy = await this.healthCheck(port)
      .then(() => true)
      .catch(() => false);

    if (!healthy) {
      return false;
    }

    this._isReady = true;
    this._updateStatus("$(unmute) TTS: ready", false);
    this.log(`[INFO] Reusing existing healthy TTS server on 127.0.0.1:${port}`);
    return true;
  }

  private async _handleServerExit(
    code: number | null,
    port: number,
  ): Promise<void> {
    this.log(`[INFO] TTS server exited with code ${code}`);
    this.serverProcess = undefined;

    const healthyReplacement = await this.healthCheck(port)
      .then(() => true)
      .catch(() => false);

    if (healthyReplacement) {
      this._isReady = true;
      this._updateStatus("$(unmute) TTS: ready", false);
      this.log(
        `[INFO] A healthy TTS server is still available on 127.0.0.1:${port}; keeping extension ready`,
      );
      return;
    }

    this._isReady = false;
    this._updateStatus("$(mute) TTS: stopped", false);
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private synthesize(
    text: string,
    voice: string,
    lang: string,
    port: number,
    speed: number,
  ): Promise<SynthesisResult> {
    return new Promise<SynthesisResult>((resolve, reject) => {
      const body = JSON.stringify({ text, voice, lang, speed });

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/synthesize",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            // Read the error body to extract the FastAPI `detail` field
            const errChunks: Buffer[] = [];
            res.on("data", (c: Buffer) => errChunks.push(c));
            res.on("end", () => {
              let detail = `HTTP ${res.statusCode}`;
              try {
                const parsed = JSON.parse(
                  Buffer.concat(errChunks).toString(),
                ) as { detail?: string };
                if (parsed.detail) {
                  detail = parsed.detail;
                }
              } catch {
                /* non-JSON body — use the status code */
              }
              reject(new Error(detail));
            });
            res.on("error", reject);
            return;
          }
          const chunks: Buffer[] = [];
          const dur = parseFloat(
            (res.headers["x-audio-duration"] as string | undefined) ?? "0",
          );
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ buffer: Buffer.concat(chunks), duration: dur }),
          );
          res.on("error", reject);
        },
      );

      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error("TTS request timed out"));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private async waitForServer(port: number, maxWaitMs: number): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const ok = await this.healthCheck(port)
        .then(() => true)
        .catch(() => false);
      if (ok) {
        return;
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    throw new Error(
      `TTS server on port ${port} did not become healthy within ${maxWaitMs / 1000}s.\n` +
        "First start may take several minutes while Supertonic downloads model files.\n" +
        'If this keeps failing, run "Copilot TTS: Initialize Copilot TTS" to install and configure Copilot TTS first.',
    );
  }

  private async waitForServerOrExit(
    process: ChildProcess,
    port: number,
    maxWaitMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finishWithError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        process.off("close", onClose);
        process.off("error", onError);
        reject(error);
      };

      const onClose = (code: number | null): void => {
        finishWithError(
          new Error(
            `server process exited early with code ${code ?? "unknown"}`,
          ),
        );
      };

      const onError = (error: Error): void => {
        finishWithError(
          new Error(`server process failed to start: ${error.message}`),
        );
      };

      process.once("close", onClose);
      process.once("error", onError);

      void this.waitForServer(port, maxWaitMs)
        .then(() => {
          if (settled) {
            return;
          }
          settled = true;
          process.off("close", onClose);
          process.off("error", onError);
          resolve();
        })
        .catch((error) => {
          finishWithError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  private _getPythonStartupCandidates(
    context: vscode.ExtensionContext,
    configuredPython: string | undefined,
  ): PythonCommandSpec[] {
    const trimmed = configuredPython?.trim();
    const managedVenvPython = getManagedVenvPythonPath(context);

    if (!trimmed) {
      if (managedVenvPython) {
        this.log(
          `[INFO] Reusing managed Copilot TTS Python from ${managedVenvPython}`,
        );
        return getPythonCommandCandidates(managedVenvPython);
      }

      return getPythonCommandCandidates(undefined);
    }

    const configuredSpec = getConfiguredPythonCommand(trimmed);
    const looksLikePath =
      configuredSpec.args.length === 0 &&
      (path.isAbsolute(configuredSpec.command) ||
        configuredSpec.command.includes("\\") ||
        configuredSpec.command.includes("/"));

    if (looksLikePath && !fs.existsSync(configuredSpec.command)) {
      if (managedVenvPython) {
        this.log(
          `[INFO] Stored copilot-tts.pythonPath was not found (${configuredSpec.command}); reusing managed Copilot TTS Python from ${managedVenvPython}`,
        );
        return getPythonCommandCandidates(managedVenvPython);
      }

      this.log(
        `[INFO] Stored copilot-tts.pythonPath was not found (${configuredSpec.command}); falling back to auto-detected Python commands`,
      );
      return getPythonCommandCandidates(undefined);
    }

    return getPythonCommandCandidates(trimmed);
  }

  private healthCheck(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          reject();
        }
        res.resume();
      });
      req.setTimeout(2_000, () => {
        req.destroy();
        reject();
      });
      req.on("error", reject);
    });
  }
}

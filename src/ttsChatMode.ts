import * as vscode from "vscode";
import { TtsService } from "./ttsService";
import { TtsHookProvider } from "./ttsHookProvider";

type HookPlaybackState = NonNullable<
  Parameters<Parameters<TtsHookProvider["onDidChangePlaybackState"]>[0]>[0]
>;

/**
 * Manages the "TTS Chat Mode" toggle.
 *
 * When enabled, writes an extension-owned Stop hook configuration file and
 * registers its path through VS Code's `chat.hookFilesLocations` setting.
 * Copilot executes that hook after a normal typed request stops, with the
 * session transcript flushed to disk first. The hook runner reads the latest
 * assistant transcript content and plays it through the local TTS server.
 *
 * The hook file is only registered while the mode is active, so normal Copilot
 * behavior is unchanged when TTS Chat Mode is off.
 */
export class TtsChatMode implements vscode.Disposable {
  private static readonly _stateKey = "ttsChatModeEnabled";
  private _enabled = false;
  private _modeBar: vscode.StatusBarItem | undefined;
  private readonly _hookProvider: TtsHookProvider;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _ttsService: TtsService,
  ) {
    this._hookProvider = new TtsHookProvider(_context, _ttsService);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  get isEnabled(): boolean {
    return this._enabled;
  }

  get onDidChangeHookPlaybackState(): vscode.Event<
    HookPlaybackState | undefined
  > {
    return this._hookProvider.onDidChangePlaybackState;
  }

  get onDidReceiveHookResponse(): vscode.Event<
    { sessionId?: string; chatName?: string; text: string } | undefined
  > {
    return this._hookProvider.onDidReceiveHookResponse;
  }

  setModeBar(bar: vscode.StatusBarItem): void {
    this._modeBar = bar;
    this._updateModeBar();
  }

  async restore(): Promise<void> {
    const configDefault = vscode.workspace
      .getConfiguration("copilot-tts")
      .get<boolean>("autoRouteAllChat", false);
    const persisted = this._context.globalState.get<boolean | undefined>(
      TtsChatMode._stateKey,
    );
    const shouldEnable = persisted ?? configDefault;

    this._ttsService.log(
      `[TTS ChatMode] restore persisted=${String(persisted)} configDefault=${String(configDefault)} -> enabled=${String(shouldEnable)}`,
    );

    if (shouldEnable) {
      await this._setEnabled(true, "restore");
    } else {
      this._updateModeBar();
    }
  }

  async toggle(): Promise<void> {
    await this._setEnabled(!this._enabled, "toggle");
  }

  async refreshConfiguration(): Promise<void> {
    await this._hookProvider.refreshConfiguration();
  }

  async loadLastHookResponse(): Promise<
    | {
        sessionId?: string;
        vsCodeSessionId?: string;
        chatName?: string;
        text: string;
      }
    | undefined
  > {
    return this._hookProvider.loadLastHookResponse();
  }

  async loadHookResponseForSession(sessionKey: string): Promise<
    | {
        sessionId?: string;
        vsCodeSessionId?: string;
        chatName?: string;
        text: string;
      }
    | undefined
  > {
    return this._hookProvider.loadHookResponseForSession(sessionKey);
  }

  async setSessionLabel(sessionKey: string, label: string): Promise<void> {
    await this._hookProvider.setSessionLabel(sessionKey, label);
  }

  async stopHookPlayback(): Promise<boolean> {
    return this._hookProvider.stopPlayback();
  }

  async enable(): Promise<void> {
    if (!this._enabled) {
      await this._setEnabled(true, "enable");
    }
  }

  async disable(): Promise<void> {
    if (this._enabled) {
      await this._setEnabled(false, "disable");
    }
  }

  dispose(): void {
    this._hookProvider.dispose();
    this._modeBar?.dispose();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async _setEnabled(
    enabled: boolean,
    source: "toggle" | "enable" | "disable" | "restore",
  ): Promise<void> {
    if (this._enabled === enabled) {
      if (enabled) {
        await this._hookProvider.refreshConfiguration();
      }
      this._updateModeBar();
      return;
    }

    if (enabled) {
      const ready = await this._ensureServerReady(source);
      if (!ready) {
        this._ttsService.log(
          `[TTS ChatMode] ${source}: leaving TTS Chat Mode disabled because setup did not complete`,
        );
        this._updateModeBar();
        return;
      }
    }

    this._enabled = enabled;
    await this._context.globalState.update(TtsChatMode._stateKey, enabled);
    this._ttsService.setChatModeEnabled(enabled);
    this._ttsService.log(
      `[TTS ChatMode] ${source}: TTS Chat Mode ${enabled ? "ENABLED" : "DISABLED"}`,
    );
    this._updateModeBar();

    if (enabled) {
      await this._hookProvider.setEnabled(true);
    } else {
      await this._hookProvider.setEnabled(false);
    }
  }

  private _updateModeBar(): void {
    if (!this._modeBar) {
      return;
    }
    if (this._enabled) {
      this._modeBar.text = "$(unmute) TTS: chat ON";
      this._modeBar.tooltip =
        "TTS Chat Mode is ENABLED — Copilot Stop hooks will read plain chat responses aloud.\nClick to disable.";
      this._modeBar.color = undefined;
      this._modeBar.backgroundColor = undefined;
    } else {
      this._modeBar.text = "$(mute) TTS: chat OFF";
      this._modeBar.tooltip =
        "TTS Chat Mode is DISABLED — click to enable auto-read for all chat responses.";
      this._modeBar.color = undefined;
      this._modeBar.backgroundColor = undefined;
    }
  }

  private async _ensureServerReady(
    source: "toggle" | "enable" | "disable" | "restore",
  ): Promise<boolean> {
    if (this._ttsService.isReady) {
      this._ttsService.log("[TTS ChatMode] TTS server already ready");
      return true;
    }

    this._ttsService.log(
      "[TTS ChatMode] TTS server is not ready; attempting to start it now",
    );

    try {
      await this._ttsService.startServer(this._context, {
        showAlreadyRunningMessage: false,
        showReadyMessage: false,
      });
      this._ttsService.log("[TTS ChatMode] TTS server started successfully");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._ttsService.log(
        `[TTS ChatMode] failed to start TTS server: ${message}`,
      );

      const shouldPromptManualInit = source === "toggle" || source === "enable";

      if (shouldPromptManualInit) {
        vscode.window.showErrorMessage(
          'Copilot TTS Chat Mode could not start the local TTS server. Run "Copilot TTS: Initialize Copilot TTS" first.',
        );
      }

      return false;
    }
  }
}

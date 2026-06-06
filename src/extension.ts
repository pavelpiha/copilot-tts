import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { TtsService } from "./ttsService";
import { AudioPlayer } from "./audioPlayer";
import { TtsControlPanelProvider } from "./ttsControlPanel";
import { runInitialize } from "./initializer";
import { TtsChatMode } from "./ttsChatMode";

let audioPlayer: AudioPlayer;
let ttsService: TtsService;
let statusBar: vscode.StatusBarItem;
let ttsChatMode: TtsChatMode;

async function cleanupLocalRuntimeData(
  context: vscode.ExtensionContext,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("copilot-tts");
  const currentPythonPath = config.get<string>("pythonPath", "").trim();
  const managedStorageRoot = context.globalStorageUri.fsPath;
  const normalizedStorageRoot = path.resolve(managedStorageRoot);
  const normalizedPythonPath = currentPythonPath
    ? path.resolve(currentPythonPath)
    : undefined;
  const storagePrefix = normalizedStorageRoot.endsWith(path.sep)
    ? normalizedStorageRoot
    : `${normalizedStorageRoot}${path.sep}`;

  if (
    normalizedPythonPath &&
    (normalizedPythonPath === normalizedStorageRoot ||
      normalizedPythonPath.startsWith(storagePrefix))
  ) {
    await config.update("pythonPath", "", vscode.ConfigurationTarget.Global);
  }

  // Delete each entry inside the directory instead of the directory itself.
  // Removing the root with fs.rm({ recursive }) ends with an fs.rmdir() call
  // on the root; if VS Code writes to the directory between the recursive
  // empty step and that final rmdir, the call throws ENOTEMPTY.
  // Deleting only the contents avoids ever calling rmdir on the root.
  let entries: string[];
  try {
    entries = await fs.readdir(managedStorageRoot);
  } catch {
    return; // directory absent — nothing to clean up
  }
  await Promise.all(
    entries.map((entry) =>
      fs.rm(path.join(managedStorageRoot, entry), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

function syncChatModeStatusBars(
  enabled: boolean,
  bars: readonly vscode.StatusBarItem[],
): void {
  for (const bar of bars) {
    if (enabled) {
      bar.show();
    } else {
      bar.hide();
    }
  }
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // ── Core services ────────────────────────────────────────────────────────
  audioPlayer = new AudioPlayer();
  ttsService = new TtsService(audioPlayer);
  ttsService.setGlobalStorageUri(context.globalStorageUri);

  // ── Output channel — created immediately so all log lines are captured ───
  // (must come before startServer so server stdout/stderr and session logs
  //  are never lost even if the user starts the server before the channel exists)
  const outputChannel = vscode.window.createOutputChannel("Copilot TTS Server");
  context.subscriptions.push(outputChannel);
  ttsService.setOutputChannel(outputChannel);
  ttsService.log("[TTS activate] extension activated");
  ttsService.log(
    `[TTS activate] activeChatSessionApi=${String(Boolean((vscode.window as any).onDidChangeActiveChatPanelSessionResource))}`,
  );

  // ── Status bar (bottom right) ────────────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "copilot-tts.showStatus";
  statusBar.text = "$(mute) TTS: stopped";
  statusBar.tooltip = "Copilot TTS — click for status";
  ttsService.setStatusBar(statusBar);

  // ── Speed status bar (always visible, shows current speed) ───────────────────
  const speedBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99, // just left of the TTS status item
  );
  speedBar.command = "copilot-tts.setSpeed";
  speedBar.tooltip = "Copilot TTS playback speed — click to change";
  speedBar.text = "$(dashboard) 1×";
  ttsService.setSpeedBar(speedBar);

  // ── TTS Chat Mode status bar (shows whether all chat responses are spoken) ─
  const chatModeBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98, // just left of the speed item
  );
  chatModeBar.command = "copilot-tts.toggleChatMode";

  // ── TTS Chat Mode controller ─────────────────────────────────────────────
  ttsChatMode = new TtsChatMode(context, ttsService);
  ttsChatMode.setModeBar(chatModeBar);

  const toggleChatModeCommand = vscode.commands.registerCommand(
    "copilot-tts.toggleChatMode",
    async () => {
      ttsService.log("[TTS command] toggleChatMode invoked");
      await ttsChatMode.toggle();
      if (!ttsChatMode.isEnabled) {
        ttsService.stopSpeaking();
        ttsService.clearLastResponseText();
      }
      syncChatModeStatusBars(ttsChatMode.isEnabled, [statusBar, speedBar]);
      const state = ttsChatMode.isEnabled ? "ENABLED" : "DISABLED";
      ttsService.log(`[TTS command] toggleChatMode completed state=${state}`);
      vscode.window.showInformationMessage(`Copilot TTS Chat Mode ${state}. `);
    },
  );

  context.subscriptions.push(ttsChatMode, chatModeBar, toggleChatModeCommand);
  chatModeBar.show();

  try {
    await ttsChatMode.restore();
    syncChatModeStatusBars(ttsChatMode.isEnabled, [statusBar, speedBar]);
    ttsService.log(
      `[TTS activate] restored chat mode enabled=${String(ttsChatMode.isEnabled)}`,
    );
    await ttsChatMode.refreshConfiguration();
    ttsService.log("[TTS activate] refreshConfiguration completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ttsService.log(
      `[WARN] Non-fatal TTS activation restore/setup failure: ${message}`,
    );
  }

  let activeChatSessionKey: string | undefined;
  const replayLastResponse = async (): Promise<void> => {
    let last = ttsService.getLastResponseText().trim();
    let lastChatName = ttsService.getLastResponseChatName();

    if (!last && ttsChatMode.isEnabled) {
      const hookResponse = activeChatSessionKey
        ? await ttsChatMode.loadHookResponseForSession(activeChatSessionKey)
        : await ttsChatMode.loadLastHookResponse();
      if (hookResponse) {
        // When falling back to the global last-response file (no active session
        // key), only use it if it was produced by THIS VS Code window.  Each
        // window stamps its own sessionId into the file; using another window's
        // response here would speak the wrong chat and corrupt _lastResponseText.
        const foreignWindow =
          !activeChatSessionKey &&
          hookResponse.vsCodeSessionId &&
          hookResponse.vsCodeSessionId !== vscode.env.sessionId;

        if (foreignWindow) {
          ttsService.log(
            `[TTS replay] skipping last-response – belongs to window ${hookResponse.vsCodeSessionId ?? "?"}`,
          );
        } else {
          ttsService.rememberHookResponse(
            hookResponse.text,
            hookResponse.sessionId,
            hookResponse.chatName,
          );
          last = hookResponse.text;
          lastChatName = hookResponse.chatName ?? "";
          ttsService.log(
            `[TTS replay] loaded hook response chars=${hookResponse.text.length} session=${hookResponse.sessionId ?? "(unknown)"}`,
          );
        }
      }
    }

    if (last) {
      if (!ttsService.isReady) {
        controlPanel.setPlaybackState(false);
        await ttsService.speak(last, lastChatName);
        return;
      }

      await ttsService.speak(last, lastChatName);
      return;
    }

    controlPanel.setPlaybackState(false);
    vscode.window.showInformationMessage("No recent TTS response to replay.");
  };

  // ── Bottom panel WebView (▶ TTS Play / ■ TTS Stop / Voice / Speed) ──────────
  const stopAllPlayback = async (): Promise<void> => {
    ttsService.stopSpeaking();
    await ttsChatMode.stopHookPlayback();
    controlPanel.setPlaybackState(false);
  };

  const controlPanel = new TtsControlPanelProvider(context.extensionUri, {
    onPlay: () => {
      controlPanel.setStatus("TTS: synthesizing…", true, true);
      void replayLastResponse();
    },
    onStop: () => {
      void stopAllPlayback();
    },
    onSpeedChange: (speed) => ttsService.setSpeed(speed),
    onVoiceChange: (voice) => {
      vscode.workspace
        .getConfiguration("copilot-tts")
        .update("voice", voice, vscode.ConfigurationTarget.Global);
    },
  });
  ttsService.setControlPanel(controlPanel);
  // If the server was already started during restore() (before the panel was
  // wired up), the "TTS: ready" postMessage was lost.  Sync the panel now.
  if (ttsService.isReady) {
    controlPanel.setStatus("TTS: ready", false, false);
  }
  context.subscriptions.push(
    ttsChatMode.onDidChangeHookPlaybackState((state) => {
      const stage = state?.stage ?? "idle";
      const active = stage === "synthesizing" || stage === "playing";

      if (stage === "playing" || stage === "idle") {
        void ttsChatMode.loadLastHookResponse().then((hookResponse) => {
          if (!hookResponse) {
            return;
          }
          // Guard: only store text that was produced by THIS window's hook.
          if (hookResponse.vsCodeSessionId !== vscode.env.sessionId) {
            return;
          }
          ttsService.rememberHookResponse(
            hookResponse.text,
            hookResponse.sessionId,
          );
        });
      }

      controlPanel.setPlaybackState(active);
      if (stage === "synthesizing") {
        controlPanel.setStatus("TTS: synthesizing…", true, true);
        return;
      }

      if (stage === "playing") {
        controlPanel.setStatus("TTS: playing…", false, true);
        return;
      }

      controlPanel.setStatus("TTS: ready", false, false);
    }),
    ttsChatMode.onDidReceiveHookResponse((hookResponse) => {
      if (!hookResponse) {
        return;
      }

      ttsService.rememberHookResponse(
        hookResponse.text,
        hookResponse.sessionId,
        hookResponse.chatName,
      );
      void ttsService.speak(hookResponse.text, hookResponse.chatName);
    }),
  );

  // ── Commands ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    statusBar,
    speedBar,

    vscode.window.registerWebviewViewProvider(
      TtsControlPanelProvider.viewType,
      controlPanel,
    ),

    vscode.commands.registerCommand("copilot-tts.stopReading", () => {
      void stopAllPlayback();
    }),

    vscode.commands.registerCommand("copilot-tts.startServer", async () => {
      try {
        await ttsService.startServer(context);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Copilot TTS: failed to start server — ${err}\n` +
            'Run "Copilot TTS: Initialize Copilot TTS" to install and configure Copilot TTS.',
        );
      }
    }),

    vscode.commands.registerCommand("copilot-tts.stopServer", async () => {
      await stopAllPlayback();
      ttsService.shutdown();
      ttsService.clearLastResponseText();
      vscode.window.showInformationMessage("Copilot TTS server stopped.");
    }),

    vscode.commands.registerCommand(
      "copilot-tts.cleanupLocalData",
      async () => {
        const choice = await vscode.window.showWarningMessage(
          "Remove Copilot TTS local runtime data? This stops the local server, disables TTS Chat Mode, removes the managed Python/runtime/model cache under VS Code global storage, and clears an extension-managed pythonPath.",
          { modal: true },
          "Remove Local Data",
        );
        if (choice !== "Remove Local Data") {
          return;
        }

        await stopAllPlayback();
        await ttsChatMode.disable();
        ttsService.clearLastResponseText();
        ttsService.shutdown();
        await cleanupLocalRuntimeData(context);
        vscode.window.showInformationMessage(
          "Copilot TTS local runtime data removed. You can uninstall the extension now.",
        );
      },
    ),

    vscode.commands.registerCommand("copilot-tts.showStatus", () => {
      const state = ttsService.isReady ? "running" : "stopped";
      vscode.window.showInformationMessage(`Copilot TTS server is ${state}.`);
    }),

    vscode.commands.registerCommand("copilot-tts.toggleDebug", async () => {
      const config = vscode.workspace.getConfiguration("copilot-tts");
      const nextValue = !config.get<boolean>("debug", false);
      ttsService.setDebug(nextValue);
      await config.update(
        "debug",
        nextValue,
        vscode.ConfigurationTarget.Global,
      );
      vscode.window.showInformationMessage(
        `Copilot TTS verbose logging ${nextValue ? "enabled" : "disabled"}.`,
      );
    }),

    // Set speed via QuickPick (also controllable from the bottom panel)
    vscode.commands.registerCommand("copilot-tts.setSpeed", async () => {
      const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
      const items = speeds.map((s) => ({
        label: `${s}\u00d7`,
        description: s === ttsService.currentSpeed ? "\u2190 current" : "",
        speed: s,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `TTS speed — current: ${ttsService.currentSpeed}\u00d7`,
      });
      if (pick) {
        ttsService.setSpeed(pick.speed);
      }
    }),

    vscode.commands.registerCommand("copilot-tts.playLast", () => {
      void replayLastResponse();
    }),

    // One-shot initializer: installs deps and starts the server
    vscode.commands.registerCommand("copilot-tts.initialize", () =>
      runInitialize(context, ttsService),
    ),
  );

  // ── Restore per-chat Play text when the user switches Copilot Chat sessions ───
  // vscode.window.onDidChangeActiveChatPanelSessionResource fires for BOTH
  // editor-area chat tabs AND the sidebar chat panel whenever the active
  // session changes. The URI last path-segment is the same session UUID that
  // the hook payload session_id carries, so we can look up the stored text
  // directly without any tab fingerprinting.
  //
  // Requires enabledApiProposals: ["chatParticipantPrivate"] in package.json.
  // VS Code validates presence of the array (not individual entries in stable
  // builds), so this works for any third-party extension.
  const winAny = vscode.window as any;
  if (typeof winAny.onDidChangeActiveChatPanelSessionResource === "function") {
    context.subscriptions.push(
      winAny.onDidChangeActiveChatPanelSessionResource(
        (uri: vscode.Uri | undefined) => {
          if (!uri) {
            if (ttsChatMode.isEnabled) {
              ttsService.debug(
                "[TTS session switch] event fired with undefined uri",
              );
            }
            return;
          }
          if (ttsChatMode.isEnabled) {
            ttsService.debug(`[TTS session switch] raw uri=${uri.toString()}`);
          }
          // The URI last path segment is the session UUID, base64-encoded.
          // Decode it and prepend "sid:" to match the key stored for
          // hook-driven replay state ("sid:<uuid>").
          const parts = uri.path.replace(/^\//, "").split("/");
          const rawSegment = parts[parts.length - 1];
          if (!rawSegment) {
            return;
          }
          let sessionKey: string;
          try {
            const decoded = Buffer.from(rawSegment, "base64").toString("utf8");
            // Validate it looks like a UUID before trusting the decode
            sessionKey = /^[0-9a-f-]{36}$/i.test(decoded)
              ? `sid:${decoded}`
              : rawSegment;
          } catch {
            sessionKey = rawSegment;
          }
          if (ttsChatMode.isEnabled) {
            ttsService.debug(
              `[TTS session switch] resolved sessionKey=${sessionKey}`,
            );
          }
          activeChatSessionKey = sessionKey;
          ttsService.restoreSession(sessionKey);
          if (ttsChatMode.isEnabled) {
            void ttsChatMode
              .loadHookResponseForSession(sessionKey)
              .then((hookResponse) => {
                if (!hookResponse || activeChatSessionKey !== sessionKey) {
                  return;
                }

                ttsService.rememberHookResponse(
                  hookResponse.text,
                  hookResponse.sessionId,
                );
                ttsService.debug(
                  `[TTS session switch] restored persisted hook response chars=${hookResponse.text.length} session=${hookResponse.sessionId ?? "(unknown)"}`,
                );
              });
          }
        },
      ),
    );
    ttsService.debug("[TTS session switch] listener registered");
  } else {
    ttsService.debug(
      "[TTS session switch] API not available in this VS Code build",
    );
  }

  // ── Restore speed / voice / debug from settings ───────────────────────────
  const cfg = vscode.workspace.getConfiguration("copilot-tts");
  ttsService.currentSpeed = cfg.get<number>("speed", 1.0);
  ttsService.setDebug(cfg.get<boolean>("debug", false));
  const initSpeed = ttsService.currentSpeed;
  speedBar.text = `$(dashboard) ${initSpeed % 1 === 0 ? String(Math.round(initSpeed)) : String(initSpeed)}×`;
  controlPanel.setSpeed(ttsService.currentSpeed);
  controlPanel.setVoice(cfg.get<string>("voice", "M1"));

  // Re-apply debug flag if the user changes it at runtime
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("copilot-tts.debug")) {
        ttsService.log(
          `[TTS config] copilot-tts.debug=${String(vscode.workspace.getConfiguration("copilot-tts").get<boolean>("debug", false))}`,
        );
        ttsService.setDebug(
          vscode.workspace
            .getConfiguration("copilot-tts")
            .get<boolean>("debug", false),
        );
      }
      if (
        e.affectsConfiguration("copilot-tts.voice") ||
        e.affectsConfiguration("copilot-tts.language") ||
        e.affectsConfiguration("copilot-tts.speed") ||
        e.affectsConfiguration("copilot-tts.pythonPath") ||
        e.affectsConfiguration("copilot-tts.port")
      ) {
        void ttsChatMode.refreshConfiguration();
      }
    }),
  );

  // ── Auto-focus controls panel (reveals the Speed / Play / Stop webview) ─
  // Defer so the workbench is ready and the panel renders correctly.
  setTimeout(() => {
    vscode.commands.executeCommand("copilot-tts.controls.focus");
  }, 1_500);
}

export function deactivate(): void {
  ttsService?.shutdown();
  audioPlayer?.dispose();
}

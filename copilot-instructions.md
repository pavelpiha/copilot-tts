# Copilot TTS Instructions

These instructions apply to the whole `copilot-tts` workspace.

## Product behavior

- Installation is manual-only. Do not auto-install or auto-bootstrap on extension activation.
- Server startup should happen only from `Copilot TTS: Initialize Copilot TTS`, explicit start, or enabling TTS Chat Mode.
- Do not modify `accessibility.voice.autoSynthesize` as part of Copilot TTS initialization; local TTS playback does not depend on that VS Code setting.
- VS Code does not provide a reliable uninstall-time cleanup hook for this extension. Keep explicit cleanup commands for runtime data instead of assuming uninstall will run extension code.
- Keep user-facing docs focused on setup, usage, settings, and troubleshooting. Internal architecture and maintainer workflow notes belong here, not in `README.md`.

## Build And Packaging

- Validate changes with `npm run compile` from the repo root.
- After each code fix, bump the patch version in `package.json` and build a fresh VSIX.
- If the packaged VSIX shows an old version, write `package.json` to disk again before packaging and verify the version with `node -p "require('./package.json').version"`.

## Runtime Notes

- TTS Chat Mode is driven by the Stop hook path. Normal chat auto-read depends on the hook firing; there is no public VS Code completion event to intercept.
- Hook replay is session-scoped. Persist and restore response history by active `sid` using `tts-session-responses.json`, not only `tts-last-response.json`.
- Hook providers are not discovered through `registerHookProvider` in this build. Register hook files through `chat.hookFilesLocations` and `chat.useHooks`.
- When touching chat routing, remember third-party chat participants can be auto-routed with `vscode.chat.registerChatParticipantDetectionProvider` and `disambiguation` metadata.
- Keep model/cache downloads under `context.globalStorageUri` so `Clean Local TTS Data` can remove them together with the managed runtime.

## Code Map

- `src/extension.ts` handles activation, commands, status bar wiring, and panel integration.
- `src/ttsChatMode.ts` owns chat mode lifecycle and toggling.
- `src/ttsHookProvider.ts` writes hook config and hook file locations.
- `server/hook_stop_tts.py` reads transcript text from the Stop hook and stores it for replay.
- `src/ttsService.ts` manages the local server lifecycle, playback queue, and replay cache.
- `src/ttsControlPanel.ts` renders the play/stop/voice/speed panel.
- `src/audioPlayer.ts` handles local WAV playback.
- `src/initializer.ts` bootstraps the managed Python environment.

## Runtime and Python handling

- Keep `copilot-tts.pythonPath` empty by default.
- On Windows, treat legacy `python3` config as an implicit default so old installs still fall back to `py -3`, `python`, and managed-runtime candidates.
- If `copilot-tts.pythonPath` is empty or points to a deleted executable, fall back to the existing managed venv under VS Code global storage before trying system `py` or `python` commands.
- If a saved `copilot-tts.pythonPath` points to a deleted executable, treat it as unset and continue discovery instead of hard-failing.
- Keep init logs concise by default. Only show per-candidate probe failures when `copilot-tts.debug` is true.

## Audio and playback

- On macOS and Windows, speed must be applied at playback time in `src/audioPlayer.ts`.
- Do not resample the synthesized WAV in `server/tts_server.py` to implement speed, because that changes pitch and perceived voice quality.
- Windows local playback should use the WPF `MediaPlayer` worker path for rate-controlled playback.
- Windows hook playback must avoid `/bin/sh` and `afplay` assumptions.

## Windows-specific maintenance

- The Windows clean script must remove uv launcher shims under `~/.local/bin` such as `python3.14.exe`; otherwise managed Python install can fail with unmanaged executable conflicts.
- After Windows-focused fixes intended for release, package a new VSIX and run the cleanup cycle with `npm run package-and-clean:windows`.

## Validation

- Use `npm run compile` for TypeScript validation.
- Use `npm run test:windows:speed` for the Windows speech speed diagnostic.
- Hook playback validation can use `mise exec python@3.12 -- python -m unittest -v server.test_hook_stop_tts`.
- The Windows speed diagnostic is intended to synthesize real speech through the local model and play it at multiple speeds. Prefer that over tone-only playback checks.

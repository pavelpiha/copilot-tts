import * as vscode from "vscode";
import * as crypto from "crypto";

/**
 * WebviewView that renders in VS Code's bottom panel tab.
 * Contains: Speed selector, Play button, Stop button, status/spinner.
 */
export class TtsControlPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "copilot-tts.controls";

  private view?: vscode.WebviewView;
  private _currentSpeed = 1.0;
  private _currentVoice = "M1";
  private _isPlaying = false;
  private _canPlay = false;
  private _currentQueueItems: Array<{ chatName: string; playing: boolean }> =
    [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly callbacks: {
      onPlay: () => void;
      onStop: () => void;
      onSpeedChange: (speed: number) => void;
      onVoiceChange: (voice: string) => void;
    },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    view.webview.html = this.buildHtml();
    this.setPlaybackState(this._isPlaying);
    this.setReplayAvailable(this._canPlay);
    this.setQueue(this._currentQueueItems);

    // Re-sync all state whenever the panel becomes visible again.
    // The webview is destroyed when the panel is collapsed (retainContextWhenHidden
    // defaults to false), so visibility changes mean a full re-init.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.setPlaybackState(this._isPlaying);
        this.setReplayAvailable(this._canPlay);
        this.setQueue(this._currentQueueItems);
      }
    });

    // Note: initial speed/voice are baked into the HTML via buildHtml() to
    // avoid a race where postMessage fires before the webview JS has loaded.

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case "play":
          this.callbacks.onPlay();
          break;
        case "stop":
          this.callbacks.onStop();
          break;
        case "speed":
          this.callbacks.onSpeedChange(parseFloat(msg.value));
          break;
        case "voice":
          this.callbacks.onVoiceChange(msg.value as string);
          break;
      }
    });
  }

  /** Update the status text and optional spinner shown in the panel. */
  setStatus(text: string, spinning = false, playing = false): void {
    this._isPlaying = playing;
    this.view?.webview.postMessage({ type: "status", text, spinning, playing });
  }

  setPlaybackState(playing: boolean): void {
    this._isPlaying = playing;
    this.view?.webview.postMessage({ type: "playback", playing });
  }

  setReplayAvailable(canPlay: boolean): void {
    this._canPlay = canPlay;
    this.view?.webview.postMessage({ type: "replay-availability", canPlay });
  }

  /** Sync the speed selector to a programmatically-set value. */
  setSpeed(speed: number): void {
    this._currentSpeed = speed;
    this.view?.webview.postMessage({ type: "speed", value: speed });
  }

  /** Sync the voice selector to a programmatically-set value. */
  setVoice(voice: string): void {
    this._currentVoice = voice;
    this.view?.webview.postMessage({ type: "voice", value: voice });
  }

  /** Update the playback queue display in the panel. */
  setQueue(items: Array<{ chatName: string; playing: boolean }>): void {
    this._currentQueueItems = items;
    this.view?.webview.postMessage({ type: "queue", items });
  }

  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const speed = this._currentSpeed;
    const voice = this._currentVoice;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 10px;
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  #btn-row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
  #playBtn, #stopBtn { width: 100px; flex: 1 1 100px; max-width: 140px; }
  .status-line {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  #statusLabel {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }
  #status   { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctrl-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .ctrl-group { display: flex; align-items: center; gap: 4px; }
  label {
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 2px 5px;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
  }
  /* ── custom dropdown ─────────────────────────────────────────────────── */
  .dd { position: relative; display: inline-block; }
  .dd-btn {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 2px 20px 2px 6px;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    font-family: var(--vscode-font-family);
    white-space: nowrap;
    min-width: 80px;
    text-align: left;
    position: relative;
  }
  .dd-btn::after {
    content: '';
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    border: 4px solid transparent;
    border-top: 5px solid currentColor;
    border-bottom: 0;
    opacity: 0.7;
  }
  .dd-list {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 999;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 2px;
    margin-top: 2px;
    min-width: 100%;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-height: 200px;
    overflow-y: auto;
  }
  .dd.open .dd-list { display: block; }
  .dd-item {
    padding: 3px 10px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    white-space: nowrap;
  }
  .dd-item:hover { background: var(--vscode-list-hoverBackground); }
  .dd-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  button:not(.dd-btn) {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 3px 10px;
    border-radius: 2px;
    cursor: pointer;
    font-size: var(--vscode-font-size);
    white-space: nowrap;
    width: 100px;
    max-width: 100px;
  }
  button:not(.dd-btn) .icon { font-size: 0.75em; vertical-align: middle; }
  .sym { display: inline-block; vertical-align: middle; }
  .sym-play {
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 5px 0 5px 9px;
    border-color: transparent transparent transparent currentColor;
    background: transparent;
  }
  .sym-stop {
    width: 9px;
    height: 9px;
    background: currentColor;
  }
  button:not(.dd-btn):hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:not(.dd-btn):disabled { opacity: 0.45; cursor: not-allowed; }
  #status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin {
    display: inline-block;
    animation: spin 0.8s linear infinite;
    margin-right: 3px;
  }
  /* ── queue table ─────────────────────────────────────────────────────── */
  #queue-section {
    display: none;
    margin-top: 4px;
    max-width: 300px;
    min-width: 150px;
  }
  #queue-section.visible { display: block; }
  .queue-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    table-layout: fixed;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  .queue-table th {
    text-align: left;
    color: var(--vscode-descriptionForeground);
    font-weight: normal;
    padding: 1px 4px 2px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    white-space: nowrap;
  }
  .queue-table th:first-child { width: 80%; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
  .queue-table th:last-child  { width: 20%; text-align: right; }
  .queue-table td {
    padding: 2px 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
  }
  .queue-table td:first-child {
    border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }
  .queue-table td:last-child {
    text-align: right;
    overflow: visible;
    white-space: nowrap;
  }
  .queue-table tr:last-child td { border-bottom: none; }
  .queue-row-playing td { font-weight: 600; }
</style>
</head>
<body>
  <div id="btn-row">
    <button id="playBtn" disabled><span class="sym sym-play"></span> Play</button>
    <button id="stopBtn" disabled><span class="sym sym-stop"></span> Stop</button>
  </div>
  <div class="status-line">
    <label id="statusLabel">TTS status:</label>
    <span id="status">Idle</span>
  </div>
  <div id="queue-section">
    <table class="queue-table">
      <thead><tr><th>Chat</th><th>Status</th></tr></thead>
      <tbody id="queue-body"></tbody>
    </table>
  </div>
  <div class="ctrl-row">
    <div class="ctrl-group">
      <label>Voice</label>
      <div class="dd" id="voiceDd">
        <button class="dd-btn" id="voiceBtn" type="button"></button>
        <div class="dd-list" id="voiceList">
          <div class="dd-item" data-group="Female" data-val="F1">Emma (F1)</div>
          <div class="dd-item" data-group="Female" data-val="F2">Sophia (F2)</div>
          <div class="dd-item" data-group="Female" data-val="F3">Grace (F3)</div>
          <div class="dd-item" data-group="Female" data-val="F4">Luna (F4)</div>
          <div class="dd-item" data-group="Male" data-val="M1">Adam (M1)</div>
          <div class="dd-item" data-group="Male" data-val="M2">Brian (M2)</div>
          <div class="dd-item" data-group="Male" data-val="M3">Charlie (M3)</div>
          <div class="dd-item" data-group="Male" data-val="M4">Daniel (M4)</div>
        </div>
      </div>
    </div>
    <div class="ctrl-group">
      <label>Speed</label>
      <div class="dd" id="spdDd">
        <button class="dd-btn" id="spdBtn" type="button"></button>
        <div class="dd-list" id="spdList">
          <div class="dd-item" data-val="0.5">0.5x</div>
          <div class="dd-item" data-val="0.75">0.75x</div>
          <div class="dd-item" data-val="1.0">1x</div>
          <div class="dd-item" data-val="1.25">1.25x</div>
          <div class="dd-item" data-val="1.5">1.5x</div>
          <div class="dd-item" data-val="2.0">2x</div>
          <div class="dd-item" data-val="2.5">2.5x</div>
          <div class="dd-item" data-val="3.0">3x</div>
        </div>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const statusEl = document.getElementById('status');
  const playBtn  = document.getElementById('playBtn');
  const stopBtn  = document.getElementById('stopBtn');
  let isPlaying = false;
  let canPlay = false;

  // ── custom dropdown logic ──────────────────────────────────────────────
  let currentSpeed = '${speed}';
  let currentVoice = '${voice}';

  function initDd(ddId, btnId, listId, currentVal, onSelect) {
    const dd   = document.getElementById(ddId);
    const btn  = document.getElementById(btnId);
    const list = document.getElementById(listId);
    const items = list.querySelectorAll('.dd-item');

    function setVal(val) {
      const numVal = parseFloat(val);
      items.forEach(i => {
        const match = isNaN(numVal)
          ? i.dataset.val === val
          : Math.abs(parseFloat(i.dataset.val) - numVal) < 0.001;
        i.classList.toggle('selected', match);
      });
      const found = Array.from(items).find(i => {
        return isNaN(numVal)
          ? i.dataset.val === val
          : Math.abs(parseFloat(i.dataset.val) - numVal) < 0.001;
      });
      btn.textContent = found ? found.textContent : val;
    }
    setVal(currentVal);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.dd.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
      dd.classList.toggle('open');
    });
    items.forEach(item => {
      item.addEventListener('click', () => {
        setVal(item.dataset.val);
        dd.classList.remove('open');
        onSelect(item.dataset.val);
      });
    });
    return setVal;
  }

  document.addEventListener('click', () => document.querySelectorAll('.dd.open').forEach(d => d.classList.remove('open')));

  const setSpdVal   = initDd('spdDd',   'spdBtn',   'spdList',   currentSpeed, val => vscode.postMessage({ type: 'speed', value: val }));
  const setVoiceVal = initDd('voiceDd', 'voiceBtn', 'voiceList', currentVoice, val => vscode.postMessage({ type: 'voice', value: val }));

  function syncPlaybackButtons(playing) {
    isPlaying = Boolean(playing);
    playBtn.disabled = isPlaying || !canPlay;
    stopBtn.disabled = !isPlaying;
  }

  function syncReplayAvailability(nextCanPlay) {
    canPlay = Boolean(nextCanPlay);
    syncPlaybackButtons(isPlaying);
  }

  function normalizeStatusText(text) {
    return String(text).replace(/^TTS:\s*/i, '');
  }

  function setStatusText(text, spinning) {
    statusEl.innerHTML = spinning
      ? '<span class="spin">⟳</span>' + normalizeStatusText(text)
      : normalizeStatusText(text);
  }

  function armPlayState() {
    syncPlaybackButtons(true);
    setStatusText('TTS: synthesizing…', true);
  }

  function armStopState() {
    syncPlaybackButtons(false);
  }

  function isKeyboardActivation(event) {
    return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
  }

  function triggerPlay() {
    if (playBtn.disabled) {
      return;
    }

    armPlayState();
    vscode.postMessage({ type: 'play' });
  }

  function triggerStop() {
    if (stopBtn.disabled) {
      return;
    }

    armStopState();
    vscode.postMessage({ type: 'stop' });
  }

  playBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    triggerPlay();
  });
  playBtn.addEventListener('keydown', (event) => {
    if (isKeyboardActivation(event)) {
      event.preventDefault();
      triggerPlay();
    }
  });
  playBtn.addEventListener('click', (event) => event.preventDefault());

  stopBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    triggerStop();
  });
  stopBtn.addEventListener('keydown', (event) => {
    if (isKeyboardActivation(event)) {
      event.preventDefault();
      triggerStop();
    }
  });
  stopBtn.addEventListener('click', (event) => event.preventDefault());
  syncPlaybackButtons(false);

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'status') {
      setStatusText(data.text, Boolean(data.spinning));
      if (data.playing !== undefined) {
        syncPlaybackButtons(Boolean(data.playing));
      }
    }
    if (data.type === 'playback') {
      syncPlaybackButtons(Boolean(data.playing));
    }
    if (data.type === 'replay-availability') {
      syncReplayAvailability(Boolean(data.canPlay));
    }
    if (data.type === 'speed') {
      const v = String(parseFloat(data.value));
      const norm = ['0.5','0.75','1','1.25','1.5','2','2.5','3'].includes(v) ? v : data.value;
      // match by numeric proximity
      const items = document.querySelectorAll('#spdList .dd-item');
      const match = Array.from(items).find(i => Math.abs(parseFloat(i.dataset.val) - parseFloat(data.value)) < 0.001);
      if (match) setSpdVal(match.dataset.val);
    }
    if (data.type === 'voice') {
      setVoiceVal(String(data.value));
    }
    if (data.type === 'queue') {
      const queueItems = Array.isArray(data.items) ? data.items : [];
      const section = document.getElementById('queue-section');
      const body = document.getElementById('queue-body');
      body.innerHTML = '';
      if (queueItems.length === 0) {
        section.classList.remove('visible');
      } else {
        queueItems.forEach(function(item) {
          const tr = document.createElement('tr');
          if (item.playing) tr.classList.add('queue-row-playing');
          const tdName = document.createElement('td');
          const name = item.chatName || '(unnamed)';
          tdName.textContent = name;
          tdName.title = name;
          const tdStatus = document.createElement('td');
          tdStatus.textContent = item.playing ? 'playing' : 'queued';
          tr.appendChild(tdName);
          tr.appendChild(tdStatus);
          body.appendChild(tr);
        });
        section.classList.add('visible');
      }
    }
  });
</script>
</body>
</html>`;
  }
}

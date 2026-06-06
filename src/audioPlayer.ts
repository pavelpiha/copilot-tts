import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess, spawn } from "child_process";

const CREATE_NO_WINDOW = 0x08000000;

/**
 * Cross-platform WAV playback with variable speed.
 *
 * Speed is applied at local playback time where the platform supports it.
 *
 * macOS   → afplay (built-in, supports -r playback rate)
 * Windows → hidden WPF MediaPlayer worker (fallback: hidden SoundPlayer)
 * Linux   → aplay (speed ignored)
 */
export class AudioPlayer {
  private currentProcess: ChildProcess | undefined;
  private pendingTempFile: string | undefined;

  /**
   * @param wavBuffer   Raw WAV bytes.
   * @param speed       Playback rate (1.0 = normal).
   * @param durationSec Original audio length in seconds (used on Windows).
   */
  async play(wavBuffer: Buffer, speed = 1.0, durationSec = 0): Promise<void> {
    this.stop();

    const tmpFile = path.join(os.tmpdir(), `copilot-tts-${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, wavBuffer);
    this.pendingTempFile = tmpFile;

    return new Promise<void>((resolve, reject) => {
      const platform = os.platform();
      let proc: ChildProcess;
      let stderr = "";

      if (platform === "darwin") {
        proc = spawn("afplay", ["-r", String(speed), tmpFile], {
          stdio: "ignore",
        });
      } else if (platform === "win32") {
        proc = this.spawnWindowsPlayer(tmpFile, speed, durationSec);
      } else {
        // Linux: aplay (no speed control)
        proc = spawn("aplay", [tmpFile], { stdio: "ignore" });
      }

      this.currentProcess = proc;
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        this.deleteTempFile(tmpFile);
        this.currentProcess = undefined;
        if (code === 0 || code === null) {
          resolve();
        } else {
          const details = stderr.trim();
          reject(
            new Error(
              details
                ? `Audio player exited with code ${code}: ${details}`
                : `Audio player exited with code ${code}`,
            ),
          );
        }
      });

      proc.on("error", (err) => {
        this.deleteTempFile(tmpFile);
        this.currentProcess = undefined;
        reject(err);
      });
    });
  }

  private spawnWindowsPlayer(
    tmpFile: string,
    speed: number,
    durationSec: number,
  ): ChildProcess {
    const safeFile = tmpFile.replace(/\\/g, "\\\\").replace(/'/g, "''");
    const effectiveDuration =
      Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;

    const script = [
      "$ErrorActionPreference='Stop'",
      `$path = '${safeFile}'`,
      `$rate = ${String(speed)}`,
      `$durationSeconds = ${String(effectiveDuration)}`,
      "$player = $null",
      "try {",
      "  Add-Type -AssemblyName PresentationCore",
      "  Add-Type -AssemblyName WindowsBase",
      "  $player = New-Object System.Windows.Media.MediaPlayer",
      "  $player.Open([Uri]$path)",
      "  try { $player.SpeedRatio = $rate } catch { }",
      "  $player.Volume = 1.0",
      "  $player.Play()",
      "  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $durationSeconds + 2))",
      "  while ([DateTime]::UtcNow -lt $deadline) {",
      "    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)",
      "    if ($player.NaturalDuration.HasTimeSpan -and $player.Position -ge $player.NaturalDuration.TimeSpan) { break }",
      "    Start-Sleep -Milliseconds 50",
      "  }",
      "  exit 0",
      "}",
      "catch {",
      "  try {",
      "    $fallback = New-Object System.Media.SoundPlayer $path",
      "    $fallback.Load()",
      "    $fallback.PlaySync()",
      "    exit 0",
      "  }",
      "  catch {",
      "    Write-Error $_",
      "    exit 1",
      "  }",
      "}",
      "finally {",
      "  if ($player -ne $null) {",
      "    try { $player.Stop() } catch { }",
      "    try { $player.close() } catch { }",
      "  }",
      "}",
    ].join("\n");

    return spawn(
      "powershell.exe",
      [
        "-Sta",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        creationFlags: CREATE_NO_WINDOW,
      } as Parameters<typeof spawn>[2] & { creationFlags: number },
    );
  }

  stop(): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill();
      } catch {
        /* ignore */
      }
      this.currentProcess = undefined;
    }
    if (this.pendingTempFile) {
      this.deleteTempFile(this.pendingTempFile);
      this.pendingTempFile = undefined;
    }
  }

  private deleteTempFile(file: string): void {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.stop();
  }
}

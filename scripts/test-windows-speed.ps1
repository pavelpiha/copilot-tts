param(
  [string]$Text = 'This is a Copilot TTS Windows speed test. You should hear this sentence at the selected playback speed.',
  [string]$Voice = 'M1',
  [string]$Language = 'en',
  [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'This diagnostic can only run on Windows.'
}

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Net.Http

$speeds = @(0.5, 1.0, 1.5, 2.0)
$toleranceSeconds = 0.75
$httpClient = [System.Net.Http.HttpClient]::new()
$startedServer = $null

function Test-ServerReady {
  param(
    [int]$Port
  )

  try {
    $response = $httpClient.GetAsync("http://127.0.0.1:$Port/health").GetAwaiter().GetResult()
    return $response.IsSuccessStatusCode
  }
  catch {
    return $false
  }
}

function Get-PythonCandidates {
  $candidates = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

  $settingsPath = Join-Path $env:APPDATA 'Code\User\settings.json'
  if (Test-Path $settingsPath) {
    $rawSettings = Get-Content $settingsPath -Raw -ErrorAction SilentlyContinue
    $configuredMatch = [regex]::Match($rawSettings, '"copilot-tts\.pythonPath"\s*:\s*"([^"]+)"')
    if ($configuredMatch.Success) {
      $configured = $configuredMatch.Groups[1].Value.Trim()
      if ($configured) {
        $key = "$configured`0"
        if ($seen.Add($key)) {
          $candidates.Add([pscustomobject]@{ FilePath = $configured; Arguments = @(); Display = $configured })
        }
      }
    }
  }

  $managedPython = Join-Path $env:APPDATA 'Code\User\globalStorage\pavel-piha.copilot-tts\venv\Scripts\python.exe'
  if (Test-Path $managedPython) {
    $key = "$managedPython`0"
    if ($seen.Add($key)) {
      $candidates.Add([pscustomobject]@{ FilePath = $managedPython; Arguments = @(); Display = $managedPython })
    }
  }

  foreach ($candidate in @(
    [pscustomobject]@{ FilePath = 'py'; Arguments = @('-3'); Display = 'py -3' },
    [pscustomobject]@{ FilePath = 'python'; Arguments = @(); Display = 'python' },
    [pscustomobject]@{ FilePath = 'python3'; Arguments = @(); Display = 'python3' }
  )) {
    $key = "$($candidate.FilePath)`0$($candidate.Arguments -join '`0')"
    if ($seen.Add($key)) {
      $candidates.Add($candidate)
    }
  }

  return $candidates
}

function Start-TemporaryServer {
  param(
    [int]$Port
  )

  if (Test-ServerReady -Port $Port) {
    return $null
  }

  $serverScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'server\tts_server.py'
  $errors = [System.Collections.Generic.List[string]]::new()

  foreach ($candidate in Get-PythonCandidates) {
    if (($candidate.FilePath.Contains('\') -or $candidate.FilePath.Contains('/')) -and -not (Test-Path $candidate.FilePath)) {
      continue
    }

    $stdoutPath = Join-Path $env:TEMP 'copilot-tts-test-server.out.log'
    $stderrPath = Join-Path $env:TEMP 'copilot-tts-test-server.err.log'
    Remove-Item $stdoutPath, $stderrPath -ErrorAction SilentlyContinue

    try {
      $process = Start-Process -FilePath $candidate.FilePath -ArgumentList @($candidate.Arguments + @($serverScript, '--port', $Port)) -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    }
    catch {
      $errors.Add("$($candidate.Display): $($_.Exception.Message)")
      continue
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-ServerReady -Port $Port) {
        return [pscustomobject]@{
          Process = $process
          StdoutPath = $stdoutPath
          StderrPath = $stderrPath
          Display = $candidate.Display
        }
      }

      if ($process.HasExited) {
        break
      }

      Start-Sleep -Milliseconds 500
    }

    $stderrRaw = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $stdoutRaw = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $stderr = if ($null -ne $stderrRaw) { $stderrRaw.Trim() } else { '' }
    $stdout = if ($null -ne $stdoutRaw) { $stdoutRaw.Trim() } else { '' }
    $detail = ($stderr, $stdout | Where-Object { $_ }) -join ' | '
    if (-not $detail) {
      $detail = 'server did not become healthy in time'
    }
    $errors.Add("$($candidate.Display): $detail")

    try {
      if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
      }
    }
    catch {
    }
  }

  throw ("Local TTS server is not reachable on port $Port and could not be started automatically. Tried: " + ($errors -join ' | '))
}

function Assert-ServerReady {
  param(
    [int]$Port
  )

  if (-not (Test-ServerReady -Port $Port)) {
    $script:startedServer = Start-TemporaryServer -Port $Port
  }

  if (-not (Test-ServerReady -Port $Port)) {
    throw "Local TTS server is not reachable on port $Port. Run 'Copilot TTS: Initialize Copilot TTS' or start the server first."
  }
}

function Invoke-Synthesis {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text,
    [Parameter(Mandatory = $true)]
    [double]$Speed,
    [Parameter(Mandatory = $true)]
    [string]$Voice,
    [Parameter(Mandatory = $true)]
    [string]$Language,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
  )

  $payload = @{
    text = $Text
    voice = $Voice
    lang = $Language
    speed = $Speed
  } | ConvertTo-Json -Compress

  $content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, 'application/json')
  $response = $httpClient.PostAsync("http://127.0.0.1:$Port/synthesize", $content).GetAwaiter().GetResult()

  if (-not $response.IsSuccessStatusCode) {
    $detail = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    throw "Synthesis failed for speed ${Speed}x: HTTP $([int]$response.StatusCode) $detail"
  }

  $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  [System.IO.File]::WriteAllBytes($OutputPath, $bytes)

  $durationHeader = $response.Headers.GetValues('X-Audio-Duration') | Select-Object -First 1
  [pscustomobject]@{
    Path = $OutputPath
    ExpectedSeconds = [double]$durationHeader
  }
}

function Measure-Playback {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [double]$Speed,
    [Parameter(Mandatory = $true)]
    [double]$ExpectedSeconds,
    [Parameter(Mandatory = $true)]
    [string]$Announcement
  )

  $player = [System.Windows.Media.MediaPlayer]::new()
  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(2.0, $expectedSeconds + 3.0))
  $watch = [System.Diagnostics.Stopwatch]::StartNew()

  try {
    Write-Output "Playing ${Announcement}"
    $player.Open([Uri]$Path)
    $player.SpeedRatio = $Speed
    $player.Volume = 1.0
    $player.Play()

    while ([DateTime]::UtcNow -lt $deadline) {
      [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)

      if ($player.NaturalDuration.HasTimeSpan -and $player.Position -ge $player.NaturalDuration.TimeSpan) {
        break
      }

      Start-Sleep -Milliseconds 50
    }
  }
  finally {
    $watch.Stop()
    try { $player.Stop() } catch { }
    try { $player.Close() } catch { }
  }

  [pscustomobject]@{
    Speed = $Speed
    ExpectedSeconds = [Math]::Round($expectedSeconds, 2)
    ElapsedSeconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
    DeltaSeconds = [Math]::Round($watch.Elapsed.TotalSeconds - $expectedSeconds, 2)
    Passed = [Math]::Abs($watch.Elapsed.TotalSeconds - $expectedSeconds) -le $toleranceSeconds
  }
}

$wavPaths = @()

try {
  Assert-ServerReady -Port $Port

  $results = foreach ($speed in $speeds) {
    $wavPath = Join-Path $env:TEMP ("copilot-tts-speed-test-{0}.wav" -f ($speed.ToString('0.##').Replace('.', '_')))
    $wavPaths += $wavPath

    $synthesis = Invoke-Synthesis -Text "$Text Speed ${speed}x." -Speed $speed -Voice $Voice -Language $Language -Port $Port -OutputPath $wavPath
    Measure-Playback -Path $synthesis.Path -Speed $speed -ExpectedSeconds $synthesis.ExpectedSeconds -Announcement ("speech at {0}x" -f $speed.ToString('0.##'))
  }

  $results | Format-Table -AutoSize | Out-String | Write-Output

  $failures = @($results | Where-Object { -not $_.Passed })
  if ($failures.Count -gt 0) {
    throw ('Playback speed diagnostic failed for speed(s): ' + (($failures.Speed | ForEach-Object { $_.ToString('0.##') + 'x' }) -join ', '))
  }

  Write-Output 'Windows playback speed diagnostic passed.'
}
finally {
  foreach ($wavPath in $wavPaths) {
    Remove-Item $wavPath -ErrorAction SilentlyContinue
  }

  if ($startedServer -and $startedServer.Process) {
    try {
      if (-not $startedServer.Process.HasExited) {
        $startedServer.Process.Kill()
        $startedServer.Process.WaitForExit()
      }
    }
    catch {
    }

    Remove-Item $startedServer.StdoutPath, $startedServer.StderrPath -ErrorAction SilentlyContinue
  }

  $httpClient.Dispose()
}

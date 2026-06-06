import * as os from "os";

const LEGACY_DEFAULT_PYTHON_COMMAND = "python3";

export interface PythonCommandSpec {
  command: string;
  args: string[];
  display: string;
}

export function getDefaultPythonCommand(
  platform = os.platform(),
): PythonCommandSpec {
  if (platform === "win32") {
    return {
      command: "py",
      args: ["-3"],
      display: "py -3",
    };
  }

  return {
    command: "python3",
    args: [],
    display: "python3",
  };
}

export function getConfiguredPythonCommand(
  configured: string | undefined,
  platform = os.platform(),
): PythonCommandSpec {
  const trimmed = normalizeConfiguredPythonCommand(configured, platform);
  return trimmed
    ? parsePythonCommand(trimmed)
    : getDefaultPythonCommand(platform);
}

export function getPythonCommandCandidates(
  configured: string | undefined,
  platform = os.platform(),
): PythonCommandSpec[] {
  const trimmed = normalizeConfiguredPythonCommand(configured, platform);
  if (trimmed) {
    return [parsePythonCommand(trimmed)];
  }

  if (platform === "win32") {
    return dedupeCandidates([
      { command: "py", args: ["-3"], display: "py -3" },
      { command: "python", args: [], display: "python" },
      { command: "python3", args: [], display: "python3" },
    ]);
  }

  return dedupeCandidates([
    { command: "python3", args: [], display: "python3" },
    { command: "python", args: [], display: "python" },
  ]);
}

function parsePythonCommand(commandLine: string): PythonCommandSpec {
  // If the value looks like an absolute filesystem path (possibly containing
  // spaces), do NOT tokenize — treat the whole string as the executable.
  // This covers Unix paths (/usr/…, ~/…) and Windows paths (C:\…).
  if (/^[/~]/.test(commandLine) || /^[A-Za-z]:[/\\]/.test(commandLine)) {
    return { command: commandLine, args: [], display: commandLine };
  }

  const parts = tokenizeCommandLine(commandLine);
  if (parts.length === 0) {
    return getDefaultPythonCommand();
  }

  return {
    command: parts[0],
    args: parts.slice(1),
    display: commandLine,
  };
}

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function normalizeConfiguredPythonCommand(
  configured: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = configured?.trim();
  if (!trimmed) {
    return undefined;
  }

  // Older releases contributed "python3" as the default setting value.
  // On Windows that bypasses launcher auto-detection and fails before we can
  // try the normal `py -3` / `python` fallbacks.
  if (platform === "win32" && trimmed === LEGACY_DEFAULT_PYTHON_COMMAND) {
    return undefined;
  }

  return trimmed;
}

function dedupeCandidates(
  commands: readonly PythonCommandSpec[],
): PythonCommandSpec[] {
  const seen = new Set<string>();
  const result: PythonCommandSpec[] = [];

  for (const command of commands) {
    const key = `${command.command}\u0000${command.args.join("\u0000")}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(command);
  }

  return result;
}

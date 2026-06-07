import * as fs from "fs";
import { promises as fsp } from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";

export const MANAGED_PYTHON_VERSION = "3.14";
const UV_RELEASE_BASE_URL =
  "https://github.com/astral-sh/uv/releases/latest/download";

interface UvAssetSpec {
  fileName: string;
  executableName: string;
}

interface ManagedUvBootstrap {
  binaryPath: string;
  cleanup: () => Promise<void>;
}

export async function createManagedVenv(
  context: vscode.ExtensionContext,
  platform: NodeJS.Platform,
  venvDir: string,
  out: vscode.OutputChannel,
): Promise<void> {
  const uv = await ensureUvBinary(context, platform, out);
  const uvEnv = await getUvEnvironment(context);

  try {
    out.appendLine(
      `No usable local Python was found. Bootstrapping managed Python ${MANAGED_PYTHON_VERSION} with uv...`,
    );

    await fsp.rm(venvDir, { recursive: true, force: true });

    out.appendLine(
      `Running: ${uv.binaryPath} python install ${MANAGED_PYTHON_VERSION}`,
    );
    await runCommand(
      uv.binaryPath,
      ["python", "install", MANAGED_PYTHON_VERSION],
      out,
      uv.binaryPath,
      uvEnv,
    );

    out.appendLine(
      `Running: ${uv.binaryPath} venv --seed --python ${MANAGED_PYTHON_VERSION} ${venvDir}`,
    );
    await runCommand(
      uv.binaryPath,
      ["venv", "--seed", "--python", MANAGED_PYTHON_VERSION, venvDir],
      out,
      uv.binaryPath,
      uvEnv,
    );
  } finally {
    await uv.cleanup();
  }
}

export function getManagedVenvPythonPath(
  context: vscode.ExtensionContext,
  platform = os.platform(),
): string | undefined {
  const venvDir = path.join(context.globalStorageUri.fsPath, "venv");
  const pythonPath =
    platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python");

  return fs.existsSync(pythonPath) ? pythonPath : undefined;
}

async function ensureUvBinary(
  context: vscode.ExtensionContext,
  platform: NodeJS.Platform,
  out: vscode.OutputChannel,
): Promise<ManagedUvBootstrap> {
  const asset = getUvAssetSpec(platform, os.arch());
  const runtimeRoot = path.join(context.globalStorageUri.fsPath, "runtime");
  const archiveDir = path.join(runtimeRoot, "downloads");
  const extractDir = path.join(runtimeRoot, "uv", "latest", asset.fileName);
  const archivePath = path.join(archiveDir, asset.fileName);

  await fsp.mkdir(archiveDir, { recursive: true });
  await fsp.rm(archivePath, { force: true });
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.mkdir(extractDir, { recursive: true });

  const url = `${UV_RELEASE_BASE_URL}/${asset.fileName}`;
  out.appendLine(`Downloading managed runtime helper: ${url}`);
  await downloadFile(url, archivePath);

  out.appendLine(`Extracting ${asset.fileName}...`);
  await extractArchive(archivePath, extractDir, platform, out);

  const uvBinary = await findFileRecursive(extractDir, asset.executableName);
  if (!uvBinary) {
    throw new Error(
      `Managed uv bootstrap failed: ${asset.executableName} was not found after extraction.`,
    );
  }

  if (platform !== "win32") {
    await fsp.chmod(uvBinary, 0o755);
  }

  return {
    binaryPath: uvBinary,
    cleanup: async () => {
      await Promise.all([
        fsp.rm(extractDir, { recursive: true, force: true }),
        fsp.rm(archivePath, { force: true }),
      ]);
    },
  };
}

function getUvAssetSpec(platform: NodeJS.Platform, arch: string): UvAssetSpec {
  if (platform === "win32") {
    if (arch === "x64") {
      return {
        fileName: "uv-x86_64-pc-windows-msvc.zip",
        executableName: "uv.exe",
      };
    }

    if (arch === "arm64") {
      return {
        fileName: "uv-aarch64-pc-windows-msvc.zip",
        executableName: "uv.exe",
      };
    }

    if (arch === "ia32") {
      return {
        fileName: "uv-i686-pc-windows-msvc.zip",
        executableName: "uv.exe",
      };
    }
  }

  if (platform === "darwin") {
    if (arch === "arm64") {
      return {
        fileName: "uv-aarch64-apple-darwin.tar.gz",
        executableName: "uv",
      };
    }

    if (arch === "x64") {
      return {
        fileName: "uv-x86_64-apple-darwin.tar.gz",
        executableName: "uv",
      };
    }
  }

  throw new Error(
    `Managed Python bootstrap is not supported on ${platform}/${arch}.`,
  );
}

async function getUvEnvironment(
  context: vscode.ExtensionContext,
): Promise<NodeJS.ProcessEnv> {
  const runtimeRoot = path.join(context.globalStorageUri.fsPath, "runtime");
  const cacheDir = path.join(runtimeRoot, "uv-cache");
  const pythonInstallDir = path.join(runtimeRoot, "python");
  const pythonCacheDir = path.join(runtimeRoot, "python-cache");
  const toolDir = path.join(runtimeRoot, "tools");

  await Promise.all([
    fsp.mkdir(cacheDir, { recursive: true }),
    fsp.mkdir(pythonInstallDir, { recursive: true }),
    fsp.mkdir(pythonCacheDir, { recursive: true }),
    fsp.mkdir(toolDir, { recursive: true }),
  ]);

  return {
    ...process.env,
    UV_CACHE_DIR: cacheDir,
    UV_NO_MODIFY_PATH: "1",
    UV_NO_PROGRESS: "1",
    UV_PYTHON_INSTALL_DIR: pythonInstallDir,
    UV_PYTHON_CACHE_DIR: pythonCacheDir,
    UV_PYTHON_PREFERENCE: "managed",
    UV_TOOL_DIR: toolDir,
    UV_UNMANAGED_INSTALL: "1",
  };
}

async function extractArchive(
  archivePath: string,
  destinationDir: string,
  platform: NodeJS.Platform,
  out: vscode.OutputChannel,
): Promise<void> {
  if (platform === "win32") {
    await runCommand(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${escapePowerShellString(archivePath)}' -DestinationPath '${escapePowerShellString(destinationDir)}' -Force`,
      ],
      out,
      "powershell",
    );
    return;
  }

  await runCommand(
    "tar",
    ["-xzf", archivePath, "-C", destinationDir],
    out,
    "tar",
  );
}

async function downloadFile(
  url: string,
  destinationPath: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });

  return new Promise<void>((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "copilot-tts",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;

        if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
          response.resume();
          void downloadFile(location, destinationPath).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(
            new Error(`Download failed with status ${statusCode} for ${url}`),
          );
          return;
        }

        const file = fs.createWriteStream(destinationPath);
        file.on("error", reject);
        response.on("error", reject);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        response.pipe(file);
      },
    );

    request.on("error", reject);
  });
}

async function findFileRecursive(
  rootDir: string,
  fileName: string,
): Promise<string | undefined> {
  if (!fs.existsSync(rootDir)) {
    return undefined;
  }

  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }

    if (entry.isDirectory()) {
      const match = await findFileRecursive(entryPath, fileName);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function runCommand(
  cmd: string,
  args: string[],
  out: vscode.OutputChannel,
  executableForErrorHint: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { env: env ?? { ...process.env } });

    proc.stdout?.on("data", (chunk: Buffer) => out.append(chunk.toString()));
    proc.stderr?.on("data", (chunk: Buffer) => out.append(chunk.toString()));

    proc.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`"${cmd}" exited with code ${code}`));
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Executable not found: "${executableForErrorHint}".`));
      } else {
        reject(new Error(`Failed to launch "${cmd}": ${err.message}`));
      }
    });
  });
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}

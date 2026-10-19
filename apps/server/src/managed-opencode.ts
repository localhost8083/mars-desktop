import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { globalOpencodeConfigDir } from "@mars/paths";
import { engineDataEnv, engineConfigHomeEnv } from "./engine-data-home.js";
import { repairEngineStoreBeforeStart } from "./engine-store-repair.js";
import { engineInstallLogEnv } from "./install-log-host.js";

export type ManagedChildProcess = {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
};

export type ManagedProcessCloseOptions = {
  termTimeoutMs?: number;
  killTimeoutMs?: number;
  /** Whether the OS still has the process (default: signal 0 to child.pid). */
  processExists?: () => boolean;
};

/**
 * The engine reads MARS_PLUGINS_NO_DEPS (one file per line): when every
 * configured plugin is one of these files, it does not wait for its config
 * folders' npm installs before serving a project. Each file is named as given
 * and as its real path, since the engine compares resolved real paths.
 */
export function pluginsNoDepsEnv(
  files: string[],
  realpath: (file: string) => string = realpathSync.native,
): Record<string, string> {
  const names = new Set<string>();
  for (const file of files) {
    names.add(file);
    try {
      names.add(realpath(file));
    } catch {
      // A plugin that is not on disk is never loaded; its name is enough.
    }
  }
  return names.size ? { MARS_PLUGINS_NO_DEPS: [...names].join("\n") } : {};
}

/**
 * How long the engine may take to print its listening line. On Windows the
 * first start after an install or update also waits for the antivirus scan of
 * the new engine binary, which pushed past 15 s and failed the app's start.
 */
export function engineStartTimeoutMs(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  const asked = Number(env.MARS_ENGINE_START_TIMEOUT_MS);
  if (Number.isFinite(asked) && asked > 0) return asked;
  return platform === "win32" ? 60_000 : 15_000;
}

function pidExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  execution: OpencodeExecutionSnapshot;
  isAlive: () => boolean;
  close: () => Promise<void>;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

export function createManagedProcessClose(
  child: ManagedChildProcess,
  options: ManagedProcessCloseOptions = {},
): { isAlive: () => boolean; close: () => Promise<void> } {
  let closePromise: Promise<void> | null = null;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) {
      resolve();
      return;
    }
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const didExit = await Promise.race([exitedPromise.then(() => true), timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return didExit;
  };
  const isAlive = () => !exited && child.exitCode === null && child.signalCode === null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!isAlive()) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Re-check through the exit event before escalating.
      }
      if (await waitForExit(options.termTimeoutMs ?? 1_000)) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // Re-check below; kill can race a natural exit.
      }
      if (await waitForExit(options.killTimeoutMs ?? (process.platform === "win32" ? 3_000 : 500))) return;
      // A busy main thread can see its timer before the exit event of a
      // process that is already gone (seen on Windows): ask the OS.
      const exists = options.processExists ?? (() => pidExists(child.pid));
      if (exists()) {
        throw new Error("Managed Mars process did not exit after SIGKILL");
      }
    })();
    return closePromise;
  };
  return { isAlive, close };
}

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePortOnce(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

type ManagedOpencodeServerOptions = {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

class ManagedOpencodeExitError extends Error {
  readonly exitCode: number | null;

  constructor(exitCode: number | null, output: string) {
    super(`Mars server exited with code ${exitCode}${output.trim() ? `\n${output}` : ""}`);
    this.exitCode = exitCode;
  }
}

function isRetryableAddressInUseExit(error: unknown): boolean {
  return error instanceof ManagedOpencodeExitError &&
    error.exitCode === 1 &&
    /\bEADDRINUSE\b/.test(error.message);
}

async function startManagedOpencodeServer(
  options: ManagedOpencodeServerOptions,
  hostname: string,
  port: number,
): Promise<ManagedOpencodeServer> {
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  // The engine's in-process npm installs use Arborist, which audits by default.
  // That audit POST depends on npm's advisories endpoint, which has been observed
  // to hang for the full five-minute registry timeout, so first-run must not wait.
  // @npmcli/config reads npm_config_* settings from the environment.
  // The question tool is the engine's way to ask the user; the app answers it.
  const engineEnvDefaults: Record<string, string> = { npm_config_audit: "false", OPENCODE_ENABLE_QUESTION_TOOL: "1" };
  // MarsAI's engine keeps its config in an app-owned directory; see below.
  const baseEnv = { ...process.env, ...options.env };
  // The desktop's engine keeps its sessions apart from the CLI's (engine-data-home.ts).
  const dataEnv = engineDataEnv(baseEnv) ?? {};
  // ...and its configuration apart (engineConfigHomeEnv): the CLI's own
  // config's `model` must not become the engine's default model.
  const configEnv = engineConfigHomeEnv(baseEnv) ?? {};
  // The engine merges `OPENCODE_CONFIG_DIR`'s opencode.json(c) files AFTER
  // the app's OPENCODE_CONFIG file, so pointing it at the CLI's config
  // directory (~/.config/opencode) had the user's own `model` key win and
  // break anything started with the app's default — `/init` answered
  // "Model not found: 9router/glm/…". The engine reads its own config home
  // instead; the app's global config UI writes the same directory
  // (resolveOpencodeConfigFilePath, globalOpencodeRoot). A standalone
  // server run by hand keeps the shared CLI directory.
  if (!baseEnv.OPENCODE_CONFIG_DIR?.trim()) {
    engineEnvDefaults.OPENCODE_CONFIG_DIR = globalOpencodeConfigDir({ env: baseEnv });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...engineEnvDefaults,
    ...options.env,
    ...dataEnv,
    ...configEnv,
    // The install log's wrappers, first on PATH for the engine's tool shells only (install-log-host.ts).
    ...engineInstallLogEnv(baseEnv),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  // The managed engine needs its own provider environment, but never the key
  // that decrypts MarsAI-owned OAuth credentials.
  delete env.MARS_ENCRYPTION_KEY;
  // OPENCODE_PURE disables managed config/plugin loading in OpenCode 1.x;
  // inheriting it would bypass the engine-side MCP fence.
  delete env.OPENCODE_PURE;
  const injectedEnv = Object.entries({
    ...engineEnvDefaults,
    ...(options.env ?? {}),
    ...dataEnv,
    ...configEnv,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  })
    .filter((entry): entry is [string, string] => entry[0] !== "OPENCODE_PURE" && typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  // One malformed session row makes the engine answer 500 for that chat and
  // for its project's whole session list: set such rows aside first.
  await repairEngineStoreBeforeStart(env, (level, message, attributes) => {
    console[level === "warn" ? "warn" : "info"](`[engine-store] ${message}`, attributes ?? {});
  });
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const processLifecycle = createManagedProcessClose(child);

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? engineStartTimeoutMs(env);
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for Mars server after ${timeoutMs}ms`)), timeoutMs);
      let output = "";
      const done = (value: string) => {
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        for (const line of output.split("\n")) {
          if (!/^(?:opencode )?server listening\b/.test(line)) continue;
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match?.[1]) return fail(new Error(`Failed to parse Mars server URL from: ${line}`));
          done(match[1]);
        }
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.once("error", fail);
      // ChildProcess can emit "exit" before its stdio pipes have drained. Wait
      // for "close" so retry classification includes every diagnostic line.
      child.once("close", (code) => fail(new ManagedOpencodeExitError(code, output)));
    });
  } catch (error) {
    // The start failure is the error to report; a failed cleanup only adds to it.
    const cleanup = await processLifecycle.close().then(() => null, (closeError: unknown) => closeError);
    if (cleanup && error instanceof Error) {
      error.message += ` (and the engine process could not be stopped: ${cleanup instanceof Error ? cleanup.message : String(cleanup)})`;
    }
    throw error;
  }

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    execution: {
      command,
      args,
      cwd: options.cwd,
      env: injectedEnv,
    },
    isAlive: processLifecycle.isAlive,
    close: processLifecycle.close,
  };
}

export async function createManagedOpencodeServer(options: ManagedOpencodeServerOptions): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  try {
    return await startManagedOpencodeServer(options, hostname, port);
  } catch (error) {
    // The automatic free-port probe is necessarily racy. Retry exactly once on
    // the one startup failure that a new port can safely fix; explicit ports
    // and all other code-1 exits remain actionable.
    if (options.port !== undefined || !isRetryableAddressInUseExit(error)) throw error;
    const retryPort = await findFreePort(hostname, [...(options.excludedPorts ?? []), port]);
    return startManagedOpencodeServer(options, hostname, retryPort);
  }
}

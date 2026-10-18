// Ported from the CLI (mars-cli src/box/run.js, feat/local-box-backends);
// keep the two in step. Only types were added here.
//
// Running a runtime's CLI: a time limit, output caps, never a throw.

import { spawn, type ChildProcess } from "node:child_process";

type Env = NodeJS.ProcessEnv;

export type RunResult = { code: number; stdout: string; stderr: string; error?: string };
export type RunOptions = { env?: Env; timeoutMs?: number; input?: string | Buffer; maxBytes?: number; cwd?: string; signal?: AbortSignal; onLine?: (stream: "stdout" | "stderr", line: string) => void };
export type RunCommand = (bin: string, args: string[], options?: RunOptions) => Promise<RunResult>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : "spawn";
}

/**
 * Run a program with a time limit; never throws. `signal` (an AbortSignal)
 * stops it early (a probe nobody needs any more); `onLine` hears each line
 * of its output as it comes ("stdout" | "stderr", line), for progress.
 */
export function runCommand(bin: string, args: string[], { env = process.env, timeoutMs = 8_000, input, maxBytes = 64 << 20, cwd, signal, onLine }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, stdout: "", stderr: "", error: "aborted" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env, cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    const err: Buffer[] = [];
    let done = false;
    const finish = (value: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      resolve(value);
    };
    const stop = (error: string) => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish({ code: -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error });
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("aborted");
    signal?.addEventListener?.("abort", abort, { once: true });
    const lines = (stream: "stdout" | "stderr", hear: NonNullable<RunOptions["onLine"]>) => {
      let rest = "";
      return (chunk: Buffer) => {
        rest += chunk.toString("utf8");
        const parts = rest.split(/\r?\n|\r/);
        rest = parts.pop() ?? "";
        for (const line of parts) if (line) { try { hear(stream, line); } catch { /* a listener's problem */ } }
      };
    };
    const outLine = onLine ? lines("stdout", onLine) : null;
    const errLine = onLine ? lines("stderr", onLine) : null;
    child.stdout?.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes <= maxBytes) out.push(chunk); outLine?.(chunk); });
    // Progress lines can be many: keep the first 64 chunks for the error text, hear them all.
    child.stderr?.on("data", (chunk: Buffer) => { if (err.length < 64) err.push(chunk); errLine?.(chunk); });
    child.on("error", (error) => finish({ code: -1, stdout: "", stderr: errorText(error), error: errorCode(error) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

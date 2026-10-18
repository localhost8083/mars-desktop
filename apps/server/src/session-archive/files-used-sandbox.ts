/**
 * Files used in the Docker sandbox (CLI only): the files a sandboxed agent
 * uses outside the project live in its container (its /tmp, its HOME,
 * anything it made elsewhere or copied in with `mars-host`), not on this
 * machine. A path there is read in the container, as the agent sees it,
 * never from a file of this machine at the same path. Only the project
 * folders the sandbox mounts at the same path are read on this machine.
 *
 * A small Python program (the sandbox image's /usr/bin/python3, isolated
 * mode, as the container's user, one process for the run) answers each
 * step, with every path of the step on one line of its stdin: real folder (the file itself never
 * followed), type, size, SHA-256; the bytes of the files to keep; or the
 * files changed during a call under the temp folders it named. When that
 * fails (no Python in the image, the container gone, a timeout), every path
 * of the step is `unreadable`: the tracker lists it as not captured and
 * never guesses from this machine.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** A path as the container holds it. `unreadable`: the step could not ask the container. */
export type ViewFacts =
  | { canonical: string; kind: "missing" | "dir" | "other" | "unreadable" }
  | { canonical: string; kind: "file"; size: number; sha256: string | null; mtimeMs: number };

/** Where the tracker reads a path that is not on this machine (the sandbox's container). */
export type FilesUsedView = {
  /** Each path's real folder and what is there (hashing files of at most `hashBytes`). */
  inspect(paths: readonly string[], hashBytes: number): Promise<Map<string, ViewFacts>>;
  /** The bytes of each regular file of at most `maxBytes` (`too_large` past it; null: not there, not a file, unreadable). */
  read(paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer | "too_large" | null>>;
  /** The regular files under these folders changed (mtime or ctime) within [low, high] ms (bounded walk). */
  changed(dirs: readonly string[], low: number, high: number): Promise<string[]>;
};

/** The sandbox as the tracker sees it. */
export type FilesUsedSandbox = {
  /** HOME inside the sandbox: `~` and the home config the agent reads are the container's. */
  home: string;
  /** The user's home on this machine: a file the agent copied in from it sits at its host path in the container. */
  hostHome: string | null;
  /** Folders mounted from this machine at the same path (the project): read on this machine. */
  mounted: readonly string[];
  /** The container's temp folders (default /tmp and /var/tmp). */
  temps?: readonly string[];
  view: FilesUsedView;
};

/** The program the container runs (exported for its tests). */
export const FILES_USED_VIEW_SCRIPT = String.raw`
import base64, hashlib, json, os, stat, sys
def handle(req):
    out = {}
    def canon(p):
        d, b = os.path.split(p)
        r = os.path.realpath(d)
        return os.path.join(r, b) if os.path.isdir(r) else None
    def opened(p):
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            os.close(fd)
            return None, st
        return fd, st
    if req["op"] == "inspect":
        for p in req["paths"]:
            c = canon(p)
            if c is None:
                out[p] = {"canonical": p, "kind": "missing"}
                continue
            try:
                st = os.lstat(c)
            except (FileNotFoundError, NotADirectoryError):
                out[p] = {"canonical": c, "kind": "missing"}
                continue
            except OSError:
                out[p] = {"canonical": c, "kind": "unreadable"}
                continue
            if stat.S_ISDIR(st.st_mode):
                out[p] = {"canonical": c, "kind": "dir"}
                continue
            if not stat.S_ISREG(st.st_mode):
                out[p] = {"canonical": c, "kind": "other"}
                continue
            item = {"canonical": c, "kind": "file", "size": st.st_size, "sha256": None, "mtimeMs": st.st_mtime * 1000}
            if st.st_size <= req["hash"]:
                try:
                    fd, fst = opened(c)
                    if fd is not None:
                        h = hashlib.sha256()
                        with os.fdopen(fd, "rb") as f:
                            for chunk in iter(lambda: f.read(1 << 20), b""):
                                h.update(chunk)
                        item["sha256"] = h.hexdigest()
                        item["size"] = fst.st_size
                except OSError:
                    pass
            out[p] = item
    elif req["op"] == "read":
        for p in req["paths"]:
            try:
                fd, st = opened(p)
            except OSError:
                out[p] = None
                continue
            if fd is None:
                out[p] = None
                continue
            with os.fdopen(fd, "rb") as f:
                if st.st_size > req["max"]:
                    out[p] = "too_large"
                    continue
                data = f.read(req["max"] + 1)
            out[p] = "too_large" if len(data) > req["max"] else base64.b64encode(data).decode("ascii")
    elif req["op"] == "changed":
        found = []
        entries = [0]
        lo, hi = req["low"] / 1000, req["high"] / 1000
        def walk(d, depth):
            if depth > 3 or len(found) >= 128:
                return
            try:
                children = sorted(os.scandir(d), key=lambda e: e.name)
            except OSError:
                return
            for e in children:
                entries[0] += 1
                if len(found) >= 128 or entries[0] > 4000:
                    return
                try:
                    if e.is_dir(follow_symlinks=False):
                        if e.name not in ("node_modules", ".git", ".venv"):
                            walk(e.path, depth + 1)
                        continue
                    if not e.is_file(follow_symlinks=False):
                        continue
                    st = e.stat(follow_symlinks=False)
                    if lo <= max(st.st_mtime, st.st_ctime) <= hi:
                        found.append(e.path)
                except OSError:
                    pass
        for d in req["dirs"]:
            c = os.path.realpath(d)
            if os.path.isdir(c) and not os.path.islink(d):
                walk(c, 0)
        out = {"files": found}

    return out
for line in sys.stdin.buffer:
    if not line.strip():
        continue
    try:
        answer = handle(json.loads(line))
    except Exception:
        answer = {"error": True}
    sys.stdout.write(json.dumps(answer) + "\n")
    sys.stdout.flush()
`;

const STEP_TIMEOUT_MS = 20_000;
/** The container's helper ends after this long without a step. */
const IDLE_MS = 60_000;
/** Paths per exec, at most: a step past it is split. */
const PATHS_PER_EXEC = 512;

type RunResult = { code: number | null; stdout: Buffer };
export type ViewRunner = (request: unknown, maxOutputBytes: number) => Promise<RunResult>;

/**
 * One long-lived `docker exec -i <container> /usr/bin/python3 -I -c <program>`
 * answering one JSON line per request (a fresh exec per step is too slow to
 * keep a file a later call deletes at once). Requests run one at a time; a
 * failed, slow or oversized answer ends the process and the next request
 * starts another.
 */
/** How to run a program in the box with stdin open (a box backend without `docker exec`: boxsh, `container exec`). */
export type BoxExec = { bin: string; args: readonly string[]; env?: Record<string, string> };

export function dockerExecRunner(container: string, docker = "docker", timeoutMs = STEP_TIMEOUT_MS, dockerArgs: readonly string[] = [], boxExec: BoxExec | null = null): ViewRunner {
  type Live = { child: ChildProcessWithoutNullStreams; buffer: Buffer[]; size: number; waiting: ((line: Buffer | null) => void) | null };
  let live: Live | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | null = null;
  const end = (current: Live) => {
    if (live === current) live = null;
    try {
      current.child.kill("SIGKILL");
    } catch {
      // Gone.
    }
    const waiting = current.waiting;
    current.waiting = null;
    waiting?.(null);
  };
  /** An idle helper never keeps the launcher running; one with a step in flight does. */
  const hold = (current: Live, on: boolean) => {
    for (const handle of [current.child, current.child.stdin, current.child.stdout] as unknown as Array<{ ref?: () => void; unref?: () => void }>) {
      if (on) handle.ref?.();
      else handle.unref?.();
    }
  };
  const start = (): Live | null => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (boxExec
        ? spawn(boxExec.bin, [...boxExec.args, "/usr/bin/python3", "-I", "-c", FILES_USED_VIEW_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] as const, windowsHide: true, env: { ...process.env, ...(boxExec.env ?? {}) } })
        : spawn(docker, [...dockerArgs, "exec", "-i", container, "/usr/bin/python3", "-I", "-c", FILES_USED_VIEW_SCRIPT], { stdio: ["pipe", "pipe", "ignore"] as const, windowsHide: true })) as unknown as ChildProcessWithoutNullStreams;
    } catch {
      return null;
    }
    const current: Live = { child, buffer: [], size: 0, waiting: null };
    child.stdout.on("data", (chunk: Buffer) => {
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf(10);
        if (newline < 0) break;
        const line = Buffer.concat([...current.buffer, rest.subarray(0, newline)]);
        current.buffer = [];
        current.size = 0;
        rest = rest.subarray(newline + 1);
        const waiting = current.waiting;
        current.waiting = null;
        waiting?.(line);
      }
      if (rest.length > 0) {
        current.buffer.push(rest);
        current.size += rest.length;
      }
    });
    child.on("error", () => end(current));
    child.on("close", () => end(current));
    child.stdin.on("error", () => end(current));
    hold(current, false);
    return current;
  };
  return (request, maxOutputBytes) => {
    const run = tail.then(() => new Promise<RunResult>((resolvePromise) => {
      const current = live ?? (live = start());
      if (idle) clearTimeout(idle);
      if (!current) {
        resolvePromise({ code: null, stdout: Buffer.alloc(0) });
        return;
      }
      let settled = false;
      hold(current, true);
      const timer = setTimeout(() => end(current), timeoutMs);
      timer.unref?.();
      const guard = setInterval(() => {
        if (current.size > maxOutputBytes) end(current);
      }, 50);
      guard.unref?.();
      current.waiting = (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(guard);
        hold(current, false);
        resolvePromise(line && line.length <= maxOutputBytes ? { code: 0, stdout: line } : { code: null, stdout: Buffer.alloc(0) });
        if (!line) return;
        if (line.length > maxOutputBytes) end(current);
        // An idle helper goes after a while; the next step starts another.
        idle = setTimeout(() => end(current), IDLE_MS);
        idle.unref?.();
      };
      try {
        current.child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch {
        end(current);
      }
    }));
    tail = run.catch(() => undefined);
    return run;
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** A FilesUsedView over a runner (dockerExecRunner for a live container). `onFailure` hears each step that could not ask it. */
export function containerFilesUsedView(run: ViewRunner, onFailure?: (op: string) => void): FilesUsedView {
  const ask = async (request: Record<string, unknown>, maxOutputBytes: number): Promise<Record<string, unknown> | null> => {
    try {
      const result = await run(request, maxOutputBytes);
      if (result.code !== 0) throw new Error("exec failed");
      const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad answer");
      return parsed as Record<string, unknown>;
    } catch {
      onFailure?.(String(request.op));
      return null;
    }
  };
  return {
    async inspect(paths, hashBytes) {
      const out = new Map<string, ViewFacts>();
      for (const part of chunked([...new Set(paths)], PATHS_PER_EXEC)) {
        const answer = await ask({ op: "inspect", paths: part, hash: hashBytes }, 1024 + part.length * 8_192);
        for (const path of part) {
          const value = answer?.[path] as Record<string, unknown> | undefined;
          const canonical = typeof value?.canonical === "string" && value.canonical.startsWith("/") ? value.canonical : path;
          if (value?.kind === "file" && typeof value.size === "number") {
            out.set(path, { canonical, kind: "file", size: value.size, sha256: typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) ? value.sha256 : null, mtimeMs: typeof value.mtimeMs === "number" ? value.mtimeMs : 0 });
          } else if (value?.kind === "missing" || value?.kind === "dir" || value?.kind === "other") out.set(path, { canonical, kind: value.kind });
          else out.set(path, { canonical, kind: "unreadable" });
        }
      }
      return out;
    },
    async read(paths, maxBytes) {
      const out = new Map<string, Buffer | "too_large" | null>();
      // One file per exec: each answer is bounded by the per-file cap.
      for (const path of new Set(paths)) {
        const answer = await ask({ op: "read", paths: [path], max: maxBytes }, Math.ceil(maxBytes * 4 / 3) + 8_192);
        const value = answer?.[path];
        out.set(path, value === "too_large" ? "too_large" : typeof value === "string" ? Buffer.from(value, "base64") : null);
      }
      return out;
    },
    async changed(dirs, low, high) {
      if (dirs.length === 0) return [];
      const answer = await ask({ op: "changed", dirs: [...new Set(dirs)], low, high }, 1024 * 1024);
      const files = answer?.files;
      return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string" && file.startsWith("/")) : [];
    },
  };
}

/**
 * The tracker's sandbox for a sandboxed engine (`server.sandbox` of
 * src/engine-opencode.js): its container, HOME and mounted folders from the
 * record. Null without a container.
 */
export function sandboxFilesUsed(input: {
  container: string | null | undefined;
  manifest: unknown;
  cwd: string;
  hostHome: string | null;
  docker?: string;
  /** Arguments before docker's own (`-e docker` when docker is reached through wsl.exe). */
  dockerArgs?: readonly string[];
  /** The box backend's way in when it is not a container engine (bubblewrap, Apple container, the WSL distro). */
  exec?: BoxExec | null;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
}): FilesUsedSandbox | null {
  if (!input.container) return null;
  const manifest = typeof input.manifest === "object" && input.manifest !== null ? input.manifest as { home?: unknown; workspaces?: unknown } : {};
  const home = typeof manifest.home === "string" && manifest.home.startsWith("/") ? manifest.home : "/home/mars";
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")) : [];
  let warned = false;
  const view = containerFilesUsedView(dockerExecRunner(input.container, input.docker || "docker", STEP_TIMEOUT_MS, input.dockerArgs ?? [], input.exec ?? null), (op) => {
    if (warned) return;
    warned = true;
    input.log?.("warn", "Mars files used: the sandbox could not be read; its files are listed, not kept", { op });
  });
  return { home, hostHome: input.hostHome, mounted: [...new Set([input.cwd, ...workspaces])], view };
}

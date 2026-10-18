#!/usr/bin/env node
// The Linux sandbox's helpers (apps/server/src/box), next to the engine in
// the sidecars folder: box/<goos>-<goarch>/boxsh[.exe] (the shell the engine
// runs its shell tool with), box/linux-<arch>/boxd (run inside each
// project's box) and, for Linux and Windows builds, box/linux-<arch>/boxrun
// (the bubblewrap backend on Linux; copied into the Mars WSL distro on
// Windows). Built from box/go, a copy of the CLI's box/go (mars-cli
// feat/local-box-backends), with Go >= 1.22 (GO=/path/to/go), or copied from
// MARS_BOX_PREBUILT_DIR (a folder with the same layout). Linux builds also
// ship box/linux-<arch>/bwrap when the prebuilt folder has one (an optional
// static bubblewrap for systems without it; never built here). Without the
// helpers the app ships without them and the sandbox reports itself
// unavailable (boxrun alone missing: the bubblewrap and WSL distro backends
// are); nothing else changes.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..", "box", "go");
// The same folder prepare-sidecar.mjs fills (MARS_SIDECAR_DIR or --outdir).
const argv = process.argv.slice(2);
const outdirArg = argv.find((arg) => arg.startsWith("--outdir="))?.split("=")[1] ?? (argv.includes("--outdir") ? argv[argv.indexOf("--outdir") + 1] : null);
const sidecarOverride = process.env.MARS_SIDECAR_DIR?.trim() || outdirArg;
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : resolve(here, "..", "resources", "sidecars");
const out = join(sidecarDir, "box");

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" };
const GOARCH = { x64: "amd64", arm64: "arm64" };

/** The target from the same triple prepare-sidecar.mjs reads, else this machine. */
function target() {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_CFG_TARGET_TRIPLE ?? process.env.TARGET ?? "";
  const goos = triple.includes("darwin") ? "darwin" : triple.includes("windows") ? "windows" : triple.includes("linux") ? "linux" : GOOS[process.platform];
  const goarch = triple.startsWith("aarch64") ? "arm64" : triple.startsWith("x86_64") ? "amd64" : GOARCH[process.arch];
  return { goos, goarch };
}

const { goos, goarch } = target();
const files = [
  { cmd: "boxsh", goos, goarch, name: goos === "windows" ? "boxsh.exe" : "boxsh" },
  { cmd: "boxd", goos: "linux", goarch, name: "boxd" },
  // The bubblewrap backend (Linux) and the Mars WSL distro's runner (Windows copies it in).
  ...(goos === "linux" || goos === "windows" ? [{ cmd: "boxrun", goos: "linux", goarch, name: "boxrun", optional: true }] : []),
];

const go = process.env.GO?.trim() || "go";
const haveGo = spawnSync(go, ["version"], { stdio: "ignore" }).status === 0;
const prebuilt = process.env.MARS_BOX_PREBUILT_DIR?.trim() ? resolve(process.env.MARS_BOX_PREBUILT_DIR.trim()) : null;
const version = process.env.MARS_BOX_HELPER_VERSION?.trim() || "desktop";

let missing = 0;
for (const file of files) {
  const dir = join(out, `${file.goos}-${file.goarch}`);
  const dest = join(dir, file.name);
  mkdirSync(dir, { recursive: true });
  if (haveGo) {
    execFileSync(go, ["build", "-trimpath", "-buildvcs=false", "-ldflags", `-s -w -X main.version=${version}`, "-o", dest, `./cmd/${file.cmd}`], {
      cwd: source,
      stdio: "inherit",
      env: { ...process.env, GOOS: file.goos, GOARCH: file.goarch, CGO_ENABLED: "0", GOFLAGS: "-mod=mod" },
    });
  } else if (prebuilt && existsSync(join(prebuilt, `${file.goos}-${file.goarch}`, file.name))) {
    copyFileSync(join(prebuilt, `${file.goos}-${file.goarch}`, file.name), dest);
  } else {
    if (file.optional) console.warn(`Sandbox helper linux-${file.goarch}/${file.name} missing: the bubblewrap / WSL distro backends are unavailable in this build.`);
    else missing += 1;
    continue;
  }
  chmodSync(dest, 0o755);
  // A runnable local build on macOS (release builds are signed with the app).
  if (process.platform === "darwin" && file.goos === "darwin") spawnSync("codesign", ["--force", "--sign", "-", dest], { stdio: "ignore" });
  console.log(`Sandbox helper ${file.goos}-${file.goarch}/${file.name} ready.`);
}
// An optional static bubblewrap for Linux systems without one (prebuilt only).
if (goos === "linux" && prebuilt && existsSync(join(prebuilt, `linux-${goarch}`, "bwrap"))) {
  const dest = join(out, `linux-${goarch}`, "bwrap");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(prebuilt, `linux-${goarch}`, "bwrap"), dest);
  chmodSync(dest, 0o755);
  console.log(`Sandbox helper linux-${goarch}/bwrap ready.`);
}
if (missing) console.warn("Sandbox helpers missing (no Go and no MARS_BOX_PREBUILT_DIR): the Linux sandbox will report itself unavailable.");

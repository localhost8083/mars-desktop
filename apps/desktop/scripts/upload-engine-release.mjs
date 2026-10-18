// Repack the engine archives from the official sst/opencode release and
// upload them to this repo's public pre-release (see engine-release.json).
//
// The tarballs must be byte-deterministic so the sha256 pins in
// engine-release.json hold on every machine:
//   tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu
//   | gzip -n -9
//
// Usage: node scripts/upload-engine-release.mjs   (needs GH_TOKEN + gh CLI)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const release = JSON.parse(readFileSync(resolve(here, "engine-release.json"), "utf8"));
const upstreamTag = "v1.18.32";
const upstreamBase = `https://github.com/sst/opencode/releases/download/${upstreamTag}`;

// engine-release.json asset triple -> upstream source archive + inner binary.
const UPSTREAM_SOURCES = {
  "aarch64-apple-darwin": { file: "opencode-darwin-arm64.zip", binary: "opencode" },
  "x86_64-apple-darwin": { file: "opencode-darwin-x64.zip", binary: "opencode" },
  "x86_64-unknown-linux-gnu": { file: "opencode-linux-x64.tar.gz", binary: "opencode" },
  "aarch64-unknown-linux-gnu": { file: "opencode-linux-arm64.tar.gz", binary: "opencode" },
  "x86_64-pc-windows-msvc": { file: "opencode-windows-x64.zip", binary: "opencode.exe" },
  "aarch64-pc-windows-msvc": { file: "opencode-windows-arm64.zip", binary: "opencode.exe" },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const workRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), "engine-release");
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });

const artifacts = [];
for (const [triple, asset] of Object.entries(release.assets)) {
  const source = UPSTREAM_SOURCES[triple];
  if (!source) throw new Error(`No upstream source mapping for ${triple}`);
  const dir = join(workRoot, triple);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, source.file);
  console.log(`Downloading ${source.file} (${triple})...`);
  run("curl", ["-sSL", "--retry", "5", "-o", archive, `${upstreamBase}/${source.file}`]);
  if (source.file.endsWith(".zip")) run("unzip", ["-q", archive, "-d", dir]);
  else run("tar", ["-xzf", archive, "-C", dir]);
  const binary = join(dir, source.binary);
  if (!existsSync(binary)) throw new Error(`Expected binary missing after extract: ${binary}`);
  const packed = join(dir, asset.name);
  // Deterministic repack: single root binary, fixed metadata, no gzip timestamp.
  const packedResult = spawnSync(
    "bash",
    [
      "-c",
      `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - ${JSON.stringify(source.binary)} | gzip -n -9 > ${JSON.stringify(asset.name)}`,
    ],
    { cwd: dir, stdio: "inherit" },
  );
  if (packedResult.status !== 0) throw new Error(`repack failed for ${asset.name}`);
  const actual = sha256File(packed);
  if (actual !== asset.sha256) {
    throw new Error(
      `sha256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}. engine-release.json needs updating.`,
    );
  }
  artifacts.push(packed);
  console.log(`OK ${asset.name} (${actual.slice(0, 12)}...)`);
}

console.log(`Uploading ${artifacts.length} assets to ${release.repo} @ ${release.tag}...`);
const view = spawnSync("gh", ["release", "view", release.tag, "--repo", release.repo], { stdio: "ignore" });
if (view.status !== 0) {
  run("gh", [
    "release",
    "create",
    release.tag,
    "--repo",
    release.repo,
    "--prerelease",
    "--title",
    `Engine ${release.version}`,
    "--notes",
    `Deterministic engine archives for ${release.version}, repacked from sst/opencode ${upstreamTag}. Never marked latest; pinned by sha256 in apps/desktop/scripts/engine-release.json.`,
    ...artifacts,
  ]);
} else {
  run("gh", ["release", "upload", release.tag, "--repo", release.repo, "--clobber", ...artifacts]);
}
console.log("Engine release up to date.");

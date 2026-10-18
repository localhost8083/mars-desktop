#!/usr/bin/env node
/**
 * Guards the GitHub "Latest" release, which is the desktop update feed:
 * installed apps read `releases/latest/download/latest*.yml` and install only
 * a version higher than their own.
 *
 * - A fresh release must be higher than the release marked Latest. A lower
 *   version (v3.3.8 published after v3.4.1) is never installed by newer apps,
 *   and marking it Latest leaves every app at or above it with no update to
 *   find, so a required update dead-ends.
 * - A rebuild of an existing tag (recovery) is marked Latest only when it is
 *   not below the current Latest release.
 *
 * Usage:
 *   node scripts/release/latest-guard.mjs --version X.Y.Z --mode fresh|recovery [--latest-tag vA.B.C]
 * Without --latest-tag the current Latest release is read with `gh api`.
 * Prints `mark_latest=true|false` (append it to $GITHUB_OUTPUT) and exits 1
 * when the release must not be published.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStableVersions, parseStableVersion, stableVersionFromTag } from "./versions.mjs";

export const GUARD_MODES = ["fresh", "recovery"];

export function latestReleaseDecision({ version, latestVersion, mode }) {
  const problems = [];
  if (!GUARD_MODES.includes(mode)) problems.push(`Unknown mode: ${mode} (expected ${GUARD_MODES.join("|")}).`);
  if (!parseStableVersion(version)) problems.push(`Version ${version || "(empty)"} is not a stable x.y.z version.`);
  if (problems.length) return { ok: false, markLatest: false, problems };
  if (!latestVersion) return { ok: true, markLatest: true, problems };
  if (!parseStableVersion(latestVersion)) {
    return { ok: false, markLatest: false, problems: [`The release marked Latest has no stable version (${latestVersion}).`] };
  }
  const comparison = compareStableVersions(version, latestVersion);
  if (comparison > 0) return { ok: true, markLatest: true, problems };
  if (mode === "recovery") return { ok: true, markLatest: comparison === 0, problems };
  problems.push(
    comparison === 0
      ? `v${version} is already the release marked Latest; rebuild it with a workflow_dispatch (recovery) run.`
      : `v${version} is lower than the release marked Latest (v${latestVersion}). Installed apps only update to a higher version: ` +
        `apps on v${latestVersion} would never take it, and marking it Latest would leave them, and any app required to reach ` +
        `v${latestVersion}, with no update to find. Publish v${bumpPatch(latestVersion)} or higher instead.`,
  );
  return { ok: false, markLatest: false, problems };
}

function bumpPatch(version) {
  const [major, minor, patch] = parseStableVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function readLatestTag(repo) {
  try {
    return execFileSync("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"], { encoding: "utf8" }).trim();
  } catch (error) {
    // 404: the repository has no published release yet.
    if (/HTTP 404/.test(String(error?.stderr ?? error?.message ?? ""))) return "";
    throw error;
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const version = (argValue(args, "--version") ?? "").trim().replace(/^v/, "");
  const mode = (argValue(args, "--mode") ?? "fresh").trim();
  const repo = argValue(args, "--repo") ?? process.env.GITHUB_REPOSITORY ?? "mars-ai/mars-gui";
  const latestTag = argValue(args, "--latest-tag") ?? readLatestTag(repo);
  const latestVersion = latestTag ? stableVersionFromTag(latestTag) ?? latestTag : null;
  const decision = latestReleaseDecision({ version, latestVersion, mode });
  if (!decision.ok) {
    console.error(`Release v${version} refused (${mode}; Latest is ${latestTag || "none"}):`);
    for (const problem of decision.problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.error(`Release v${version} (${mode}; Latest is ${latestTag || "none"}): ${decision.markLatest ? "will be" : "will not be"} marked Latest.`);
  console.log(`mark_latest=${decision.markLatest}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

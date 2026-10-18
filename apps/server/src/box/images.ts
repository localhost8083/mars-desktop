// Ported from the CLI (mars-cli src/box/images.js + images.json,
// feat/local-box); keep the two in step. images.json is a copy of the CLI's.
//
// The prebuilt box images (box/images/<stack>/Dockerfile in the CLI repo,
// published to GHCR by its box-images workflow) and which one a project
// starts on. `base` has the build tools plus Python and Node (the two stacks
// most projects mix); the others add one toolchain on top of it.
//
// A pin's digest is null until the image is published: the tag is used and
// the digest the runtime pulled is recorded in the box record instead.
// MARS_BOX_IMAGE (every stack) or MARS_BOX_IMAGE_<STACK> overrides.

import { existsSync } from "node:fs";
import path from "node:path";

import bundledPins from "./images.json" with { type: "json" };

export const STACKS = ["base", "go", "rust", "java", "ruby"];

export type ImagePin = { ref: string; digest: string | null; approx_mb?: number | null };
export type ImagePins = { version?: string; registry?: string; images: Record<string, ImagePin> };
export type BoxImage = { stack: string; ref: string; digest: string | null; pull: string; override?: true; approxMb?: number | null };

/** Manifest files that pick a stack, checked in this order (first hit wins). */
const MARKERS: Array<[string, string[]]> = [
  ["go", ["go.mod", "go.work"]],
  ["rust", ["Cargo.toml"]],
  ["java", ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew", "mvnw"]],
  ["ruby", ["Gemfile", ".ruby-version"]],
];

export function loadPins(): ImagePins {
  return bundledPins;
}

/** The stack of a project folder from its top-level manifests (else `base`). */
export function detectStack(root: string, { exists = existsSync }: { exists?: (file: string) => boolean } = {}): string {
  for (const [stack, files] of MARKERS) {
    if (files.some((name) => exists(path.join(root, name)))) return stack;
  }
  return "base";
}

/**
 * The image a new box starts on: { stack, ref, digest, pull } where `pull`
 * is what to pull/run (ref@digest when pinned).
 */
export function imageFor(stack: string, { env = process.env, pins = loadPins() }: { env?: NodeJS.ProcessEnv; pins?: ImagePins } = {}): BoxImage {
  const name = STACKS.includes(stack) ? stack : "base";
  const override = String(env[`MARS_BOX_IMAGE_${name.toUpperCase()}`] || env.MARS_BOX_IMAGE || "").trim();
  if (override) {
    const at = override.indexOf("@sha256:");
    return { stack: name, ref: at > 0 ? override.slice(0, at) : override, digest: at > 0 ? override.slice(at + 1) : null, pull: override, override: true };
  }
  const pin = pins.images[name] ?? pins.images.base!;
  const digest = typeof pin.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(pin.digest) ? pin.digest : null;
  return { stack: name, ref: pin.ref, digest, pull: digest ? `${pin.ref.replace(/:[^/:]+$/, "")}@${digest}` : pin.ref, approxMb: pin.approx_mb ?? null };
}

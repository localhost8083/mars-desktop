// The sandbox image files that are the same in mars-cli and mars-gui: the pins
// (images.json, wsl.json), their sources (apps/desktop/box) and the scripts (scripts/box).
// Each list is the same in both repositories; this checks that every listed file still
// has its listed hash, so a change in one repository shows up until it is ported.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..", "..", "..", "..");
const lists = ["apps/server/src/box", "apps/desktop/box", "scripts/box"];

describe("CLI/desktop parity: sandbox images", () => {
  for (const dir of lists) {
    test(`${dir}/PARITY.sha256 matches its files`, () => {
      const rows = readFileSync(path.join(repo, dir, "PARITY.sha256"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const [hash, name] = row.split(/\s+/);
        const actual = createHash("sha256").update(readFileSync(path.join(repo, dir, name ?? ""))).digest("hex");
        expect(`${name} ${actual}`).toBe(`${name} ${hash}`);
      }
    });
  }
});

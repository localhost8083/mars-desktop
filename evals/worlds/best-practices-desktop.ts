import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callFunctionOnSurface } from "@mars/cdp";
import { go } from "@mars/behaviors";
import { desktop } from "@mars/hosts";
import type { Seed, Place } from "@mars/env";

const CANARY = "PRIVATE_GUI_CANARY_BEST_PRACTICES_812b";

/** Caller-owned local profile; no Den identity, account credential, or production service. */
export async function bestPracticesDesktop(seed: Seed, { place }: { place: Place }) {
  const profileDir = seed.tmpPath("best-practices-desktop-profile");
  const workspacePath = join(profileDir, "workspace");
  const canaryPath = join(workspacePath, "private-note.txt");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(canaryPath, CANARY);
  const env = {
    MARS_SESSION_UPLOAD_OPTIONAL: "1",
    MARS_ELECTRON_SKIP_SHARED_PREPARE: "1",
    ...(process.env.MARS_OPENCODE_BIN ? { MARS_OPENCODE_BIN: process.env.MARS_OPENCODE_BIN } : {}),
  };
  let active = await seed.desktop({ name: "best-practices", profileDir, env });
  const workspace = await seed.workspace(active, workspacePath);
  const route = `/workspace/${workspace.workspaceId}/settings/general`;
  await go(active, route);
  return {
    get app() { return active; },
    workspace,
    async state() {
      return callFunctionOnSurface(active, () => {
        const control = document.querySelector('[role="switch"][aria-label="Best practices"]');
        return {
          exists: control !== null,
          enabled: control?.getAttribute("aria-checked") === "true",
          disabled: control === null || control.hasAttribute("disabled")
            || control.getAttribute("aria-disabled") === "true" || control.hasAttribute("data-disabled"),
          help: document.getElementById("best-practices-help")?.textContent ?? "",
          status: document.querySelector('[data-testid="best-practices-status"]')?.textContent ?? "",
        };
      }, []);
    },
    async restart() {
      await active.stop();
      active = await desktop({ name: "best-practices-restart", host: place.host(), profileDir, env, prepareSharedResources: false });
      await go(active, route);
    },
    canaryUnchanged: async () => await readFile(canaryPath, "utf8") === CANARY,
    async [Symbol.asyncDispose]() {
      await active.stop();
      await rm(profileDir, { recursive: true, force: true });
    },
  };
}

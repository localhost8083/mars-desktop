// Launch command for the built-in UI-control MCP (packages/mars-ui-mcp).
//
// Packaged builds ship a self-contained bundle of the MCP under
// <resources>/mars-ui-mcp/index.mjs (see scripts/prepare-ui-mcp.mjs and
// electron-builder.base.yml) and run it with the app's own Electron binary in
// Node mode. The package name is not published on npm, so resolving it through
// `npx` would execute whatever a third party publishes under that name: this
// module never returns an npx command, and a packaged build without the bundle
// fails closed instead.
import { existsSync } from "node:fs";
import path from "node:path";

export const MARS_UI_MCP_RESOURCE_DIR = "mars-ui-mcp";
export const MARS_UI_MCP_ENTRY = "index.mjs";
export const MARS_UI_CONTROL_DISCOVERY_FILE = "mars-ui-control.json";

export function bundledMarsUiMcpPath(resourcesPath) {
  return path.join(resourcesPath, MARS_UI_MCP_RESOURCE_DIR, MARS_UI_MCP_ENTRY);
}

/**
 * Resolve how the engine launches the UI-control MCP.
 *
 * - Dev mode (MARS_DEV_MODE=1): the checkout's source entry under the
 *   developer's `node`, unchanged from before.
 * - Packaged: the bundled entry under this app's Electron binary with
 *   ELECTRON_RUN_AS_NODE=1, so no system Node or package registry is involved.
 * - Unpackaged non-dev runs: the checkout's source entry under this Electron
 *   binary in Node mode.
 *
 * @param {{
 *   devMode: boolean;
 *   packaged: boolean;
 *   execPath: string;
 *   resourcesPath?: string | null;
 *   repoRoot: string;
 *   userDataPath: string;
 *   exists?: (filePath: string) => boolean;
 * }} input
 * @returns {{ command: string[]; environment: Record<string, string> }}
 */
export function resolveMarsUiMcpLaunch(input) {
  const exists = input.exists ?? existsSync;
  const discovery = { MARS_UI_CONTROL_DISCOVERY: path.join(input.userDataPath, MARS_UI_CONTROL_DISCOVERY_FILE) };
  const sourceEntry = path.join(input.repoRoot, "packages", "mars-ui-mcp", MARS_UI_MCP_ENTRY);

  if (input.devMode) {
    return { command: ["node", sourceEntry], environment: discovery };
  }

  if (input.packaged) {
    const bundled = input.resourcesPath ? bundledMarsUiMcpPath(input.resourcesPath) : null;
    if (!bundled || !exists(bundled)) {
      throw new Error("The MarsAI UI-control MCP is missing from this build. Reinstall MarsAI.");
    }
    return {
      command: [input.execPath, bundled],
      environment: { ...discovery, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  if (!exists(sourceEntry)) {
    throw new Error("The MarsAI UI-control MCP source is missing from this checkout.");
  }
  return {
    command: [input.execPath, sourceEntry],
    environment: { ...discovery, ELECTRON_RUN_AS_NODE: "1" },
  };
}

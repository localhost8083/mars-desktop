/**
 * The server's one BoxService (service.ts) per ServerConfig, with the
 * workspace settings in the workspace's Mars config row
 * (`localBox: { mode: "on" | "off", offered: true }`).
 */
import { marsPluginPath } from "../mars-extensions-plugin-path.js";
import { readMarsWorkspaceConfig, writeMarsWorkspaceConfig } from "../mars-workspace-config-store.js";
import { runtimeStorageDir } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import type { BoxLog } from "./box.js";
import type { ProjectBoxMode } from "./launch.js";
import { BoxService } from "./service.js";

export const BOX_SETTINGS_KEY = "localBox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The workspace's own choice: "on", "off", or null (the server's default). */
export function readBoxSettings(mars: Record<string, unknown>): { mode: ProjectBoxMode; offered: boolean } {
  const block = isRecord(mars[BOX_SETTINGS_KEY]) ? mars[BOX_SETTINGS_KEY] : {};
  const mode = block.mode === "on" || block.mode === "off" ? block.mode : null;
  return { mode, offered: block.offered === true };
}

const services = new WeakMap<ServerConfig, BoxService>();

export function boxServiceFor(config: ServerConfig, log?: BoxLog): BoxService {
  let service = services.get(config);
  if (service) {
    if (log) service.useLog(log);
    return service;
  }
  service = new BoxService({
    stateDir: runtimeStorageDir(config),
    readSettings: async (workspaceId) => readBoxSettings(await readMarsWorkspaceConfig(config, workspaceId)),
    writeSettings: async (workspaceId, update) => {
      await writeMarsWorkspaceConfig(config, workspaceId, (current) => {
        const block = isRecord(current[BOX_SETTINGS_KEY]) ? { ...current[BOX_SETTINGS_KEY] } : {};
        if (update.mode !== undefined) {
          if (update.mode === null) delete block.mode;
          else block.mode = update.mode;
        }
        if (update.offered !== undefined) block.offered = update.offered;
        return { ...current, [BOX_SETTINGS_KEY]: block };
      });
    },
    workspaces: () => config.workspaces,
    pluginPath: () => marsPluginPath("mars-box"),
    ...(log ? { log } : {}),
  });
  services.set(config, service);
  return service;
}

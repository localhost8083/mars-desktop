import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeMarsWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseMarsWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeMarsWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const marsWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "mars_workspace_configs",
  valueColumn: "config_json",
  parse: parseMarsWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readMarsWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await marsWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeMarsWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeMarsWorkspaceConfig(updater(await readMarsWorkspaceConfig(config, workspaceId)));
  await marsWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasMarsWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return marsWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed mars config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/mars.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedMarsWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasMarsWorkspaceConfig(config, workspaceId)) {
    return readMarsWorkspaceConfig(config, workspaceId);
  }
  return writeMarsWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeMarsWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}

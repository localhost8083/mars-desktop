import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  isTrustedCloudMcpEndpointForGlobalPersist,
  MARS_CLOUD_MCP_NAME,
  readMarsCloudMcpHealth,
  reconcileMarsCloudMcp,
  refreshMarsCloudMcpEngine,
  type CloudMcpServerMetadata,
  type CloudMcpProviderModelContext,
  type CloudMcpRuntimeRegistrar,
  type CloudMcpLiveStatusObserver,
} from "../cloud-mcp-health.js";
import { ApiError } from "../errors.js";
import { assertMcpAllowed } from "../mcp-policy.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type RegisterCloudMcpRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveOpencodeDirectory: (workspace: WorkspaceInfo) => string | null;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  registerRuntimeMcp: CloudMcpRuntimeRegistrar;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
  serverMetadata?: CloudMcpServerMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerModelFromValues(provider: unknown, model: unknown): CloudMcpProviderModelContext | undefined {
  const providerValue = typeof provider === "string" ? provider.trim() : "";
  const modelValue = typeof model === "string" ? model.trim() : "";
  if (!providerValue && !modelValue) return undefined;
  if (!providerValue || !modelValue) {
    throw new ApiError(400, "invalid_payload", "provider and model must be supplied together");
  }
  return { provider: providerValue, model: modelValue };
}

function providerModelFromQuery(url: URL): CloudMcpProviderModelContext | undefined {
  return providerModelFromValues(url.searchParams.get("provider"), url.searchParams.get("model"));
}

function probeFromQuery(url: URL): boolean {
  const value = url.searchParams.get("probe")?.toLowerCase();
  return value === "1" || value === "true";
}

function providerModelFromBody(body: Record<string, unknown>): CloudMcpProviderModelContext | undefined {
  const direct = providerModelFromValues(body.provider, body.model);
  if (direct) return direct;
  if (!isRecord(body.context)) return undefined;
  return providerModelFromValues(body.context.provider, body.context.model);
}

function assertExactWorkspace(requestedId: string, workspace: WorkspaceInfo): void {
  if (requestedId.trim() !== workspace.id) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
}

function assertStrictBody(body: Record<string, unknown>, workspace: WorkspaceInfo): void {
  if (typeof body.workspaceId === "string" && body.workspaceId.trim() !== workspace.id) {
    throw new ApiError(400, "workspace_id_mismatch", "workspaceId must match the route workspace");
  }
  if (typeof body.name === "string" && body.name.trim() !== MARS_CLOUD_MCP_NAME) {
    throw new ApiError(400, "invalid_mcp_name", "Only mars-cloud can be reconciled by this endpoint");
  }
}

export function registerCloudMcpRoutes(options: RegisterCloudMcpRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveOpencodeDirectory,
    createWorkspaceOpencodeClient,
    registerRuntimeMcp,
    refreshRegistrationFromLiveStatus,
    serverMetadata,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/mcp/mars-cloud/health", "client", async () => {
    assertMcpAllowed(config);
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/mars-cloud/engine-refresh", "client", async () => {
    assertMcpAllowed(config);
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/mars-cloud/reconcile", "client", async () => {
    assertMcpAllowed(config);
  });
}

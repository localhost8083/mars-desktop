// Session-route adapter for the provider-auth store's `marsServer` slice.
//
// The settings route feeds the store the full mars-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - local endpoints (the desktop's own marsai.click server) advertise
//   `providerSync: true` — every marsai.click server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces keep the previous conservative shape (config only): a
//   desktop must not push its Den session to a shared remote worker.
import {
  createMarsServerClient,
  isLoopbackMarsServerUrl,
  readMarsServerSettings,
  type MarsServerClient,
} from "@/app/lib/mars-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthMarsServer } from "./store";

type SessionMarsServerSnapshot = ReturnType<ProviderAuthMarsServer["getSnapshot"]>;

export type CreateSessionMarsServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (marsServerInfo). */
  hostToken?: () => string;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  if (live) return live;
  // Fallback mirrors mars-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalMarsConnection writes it), but
  // only trust it for loopback servers — host tokens never travel off-machine.
  if (!isLoopbackMarsServerUrl(endpoint.baseUrl)) return "";
  return readMarsServerSettings().hostToken?.trim() ?? "";
}

export function createSessionMarsServer(
  input: CreateSessionMarsServerInput,
): ProviderAuthMarsServer {
  let clientCacheKey = "";
  let clientCacheValue: MarsServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): MarsServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createMarsServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionMarsServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          marsServerStatus: "disconnected",
          marsServerClient: null,
          marsServerCapabilities: null,
        };
      }
      if (endpoint.isRemote) {
        return {
          marsServerStatus: "connected",
          marsServerClient: endpoint.client,
          marsServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        marsServerStatus: "connected",
        marsServerClient: hostAwareClient(endpoint, hostToken),
        marsServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        marsServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}

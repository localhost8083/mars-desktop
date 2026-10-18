import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_MCP_APP_HOST_CAPABILITY,
  CONNECT_MCP_APP_HOST_CAPABILITY_HEADER,
  CONNECT_MCP_SERVER_INDEX_URI,
  connectDirectMcpRuntimeName,
  connectMcpAppHostName,
  type MarsConnectMcpServerIndex,
  readMarsConnectMcpAppHostCatalog,
  readMarsConnectMcpServerIndex,
  reconcileMarsConnectMcpServers,
  refreshMarsConnectMcpAppHostCatalog,
  writeMarsConnectMcpAppHostAuthorization,
  writeMarsConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.MARS_RUNTIME_DB;
const previousBootstrapPath = process.env.MARS_DESKTOP_BOOTSTRAP_PATH;

/** The administrator-activated enterprise Den origin every trusted fixture uses. */
const DEN = "https://den.example.com";

/** Hosted Den origins that are retired and must never be trusted by default. */
const RETIRED_HOSTED_ORIGINS = [
  "https://api.marslabs.com",
  "https://app.marslabs.com",
  "https://api.app.marslabs.com",
  "https://api.mars.software",
  "https://app.mars.software",
];

async function activateEnterpriseDen(origin: string | null): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mars-connect-mcp-bootstrap-"));
  roots.push(root);
  const path = join(root, "desktop-bootstrap.json");
  await writeFile(path, JSON.stringify(origin
    ? { baseUrl: origin, enterpriseActivation: { activatedAt: "2026-09-22T00:00:00.000Z", denBaseUrl: origin } }
    : {}), "utf8");
  process.env.MARS_DESKTOP_BOOTSTRAP_PATH = path;
}

beforeEach(async () => {
  // Never read the real desktop-bootstrap.json of whoever runs the tests.
  await activateEnterpriseDen(DEN);
});

afterEach(async () => {
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.MARS_RUNTIME_DB;
  else process.env.MARS_RUNTIME_DB = previousRuntimeDb;
  if (previousBootstrapPath === undefined) delete process.env.MARS_DESKTOP_BOOTSTRAP_PATH;
  else process.env.MARS_DESKTOP_BOOTSTRAP_PATH = previousBootstrapPath;
});

async function fixtureConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "mars-connect-mcp-servers-"));
  roots.push(root);
  process.env.MARS_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "mars.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "One", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

function indexFetcher(
  requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>,
  servers: Array<Partial<MarsConnectMcpServerIndex["servers"][number]>> = [{
    connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
    name: "Project Atlas",
    description: null,
    url: "https://den.example.com/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved",
  }],
) {
  return async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        contents: [{
          uri: CONNECT_MCP_SERVER_INDEX_URI,
          mimeType: "application/json",
          text: JSON.stringify({
            schemaVersion: "mars.connect/mcp-servers/1",
            servers,
          }),
        }],
      },
    });
  };
}

describe("MarsAI Connect MCP server catalog", () => {
  test("reads the member catalog through an authenticated MCP resource", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const index = await readMarsConnectMcpServerIndex({
      type: "remote",
      url: "https://den.example.com/mcp/agent",
      headers: { Authorization: "Bearer member-token" },
    }, "Bearer private-app-host-token", indexFetcher(requests));

    expect(index?.servers[0]?.name).toBe("Project Atlas");
    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "resources/read",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
    expect(requests.every((request) => request.headers.get(CONNECT_MCP_APP_HOST_CAPABILITY_HEADER)
      === CONNECT_MCP_APP_HOST_CAPABILITY)).toBe(true);
  });

  test("keeps same-origin provider proxies below a Den gateway prefix", async () => {
    const index = await readMarsConnectMcpServerIndex({
      type: "remote",
      url: `${DEN}/api/den/mcp/agent`,
    }, "Bearer private-app-host-token", indexFetcher([], [{
      connectionId: "emc_01k28e8q8pf8r9sff9mhyqxved",
      name: "Project Atlas",
      description: null,
      url: `${DEN}/api/den/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved`,
    }]));

    expect(index?.servers[0]?.url).toBe(
      `${DEN}/api/den/mcp/agent/connections/emc_01k28e8q8pf8r9sff9mhyqxved`,
    );
  });

  test("never sends the App-host credential to a retired hosted origin", async () => {
    // No activation: the retired hosts used to be trusted without one.
    await activateEnterpriseDen(null);
    for (const origin of RETIRED_HOSTED_ORIGINS) {
      for (const path of ["/mcp/agent", "/api/den/mcp/agent"]) {
        const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
        const index = await readMarsConnectMcpServerIndex({
          type: "remote",
          url: `${origin}${path}`,
          headers: { Authorization: "Bearer member-token" },
        }, "Bearer private-app-host-token", indexFetcher(requests, [{
          connectionId: "emc_01retired",
          name: "Retired",
          description: null,
          url: `${origin}/mcp/agent/connections/emc_01retired`,
        }]));
        expect(index).toBeNull();
        expect(requests).toEqual([]);
      }
    }

    const config = await fixtureConfig();
    for (const origin of RETIRED_HOSTED_ORIGINS) {
      let requests = 0;
      const result = await reconcileMarsConnectMcpServers({
        config,
        workspace: config.workspaces[0]!,
        cloudMcp: { type: "remote", url: `${origin}/mcp/agent`, headers: { Authorization: "Bearer member-token" } },
        appHostAuthorization: "Bearer private-app-host-token",
        fetcher: async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
      });
      expect(requests).toBe(0);
      expect(result.status).toBe("unavailable");
      expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
    }
  });

  test("the activated Den origin is trusted and a retired hosted origin next to it is not", async () => {
    const trusted: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    expect(await readMarsConnectMcpServerIndex(
      { type: "remote", url: `${DEN}/mcp/agent` },
      "Bearer private-app-host-token",
      indexFetcher(trusted),
    )).not.toBeNull();
    expect(trusted.length).toBeGreaterThan(0);

    const retired: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    expect(await readMarsConnectMcpServerIndex(
      { type: "remote", url: `${RETIRED_HOSTED_ORIGINS[0]}/mcp/agent` },
      "Bearer private-app-host-token",
      indexFetcher(retired),
    )).toBeNull();
    expect(retired).toEqual([]);
  });

  test("reconciles only MarsAI-owned proxy entries and preserves user MCPs", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "mars-cloud": { type: "remote", url: "https://den.example.com/mcp/agent" },
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "mars-connect-stale": { type: "remote", url: "https://cloud.example/stale" },
      },
    }));
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: {
        type: "remote",
        url: "https://den.example.com/mcp/agent",
        headers: { Authorization: "Bearer member-token" },
      },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([]),
    });

    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(result).toEqual({
      status: "synced",
      appHostNames: [connectMcpAppHostName(connectionId)],
      directNames: [],
      removedNames: ["mars-connect-stale"],
    });
    expect(runtime.mcp?.["mars-cloud"]).toEqual({ type: "remote", url: "https://den.example.com/mcp/agent" });
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(runtime.mcp?.["mars-connect-stale"]).toBeUndefined();
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("mars-connect-"))).toBe(false);
    expect(Object.keys(runtime.mcp ?? {}).some((name) => name.startsWith("mars-direct-"))).toBe(false);
    expect(await readMarsConnectMcpAppHostCatalog(config, "ws_1")).toEqual({
      schemaVersion: "mars.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Project Atlas",
        description: null,
        url: `https://den.example.com/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });
  });

  test("projects directly exposed connections into the model runtime with the member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const boundedId = "emc_01bounded";
    const direct = { connectionId: directId, name: "Linear (Engineering)" };
    const directName = connectDirectMcpRuntimeName(direct);
    expect(directName).toMatch(/^mars-direct-linear-engineering-[0-9a-f]{6}$/);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "mars-direct-revoked-abc123": { type: "remote", url: "https://den.example.com/mcp/agent/connections/emc_01revoked" },
      },
    }));
    const cloudMcp = {
      type: "remote",
      url: "https://den.example.com/mcp/agent",
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
    };
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://den.example.com/mcp/agent/connections/${directId}`, exposeDirectly: true },
        { connectionId: boundedId, name: "Bounded", description: null, url: `https://den.example.com/mcp/agent/connections/${boundedId}` },
      ]),
    });

    expect(result).toEqual({
      status: "synced",
      appHostNames: [connectMcpAppHostName(boundedId), connectMcpAppHostName(directId)].sort(),
      directNames: [directName],
      removedNames: ["mars-direct-revoked-abc123"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.[directName]).toEqual({
      type: "remote",
      url: `https://den.example.com/mcp/agent/connections/${directId}`,
      enabled: true,
      headers: { Authorization: "Bearer member-token" },
      oauth: false,
    });
    expect(runtime.mcp?.["mars-direct-revoked-abc123"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
    expect(Object.keys(runtime.mcp ?? {}).filter((name) => name.startsWith("mars-direct-"))).toEqual([directName]);
    expect(JSON.stringify(runtime.mcp)).not.toContain("private-app-host-token");

    // Turning the flag off removes the entry on the next reconcile.
    const revoked = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp,
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { ...direct, description: null, url: `https://den.example.com/mcp/agent/connections/${directId}`, exposeDirectly: false },
      ]),
    });
    expect(revoked.directNames).toEqual([]);
    expect(revoked.removedNames).toEqual([directName]);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.[directName]).toBeUndefined();
  });

  test("a flagged connection is not projected when the Cloud entry carries no member credential", async () => {
    const config = await fixtureConfig();
    const directId = "emc_01direct";
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [
        { connectionId: directId, name: "Linear", description: null, url: `https://den.example.com/mcp/agent/connections/${directId}`, exposeDirectly: true },
      ]),
    });
    expect(result.status).toBe("synced");
    expect(result.directNames).toEqual([]);
    expect(Object.keys((await readRuntimeOpencodeConfig(config, "ws_1")).mcp ?? {})).toEqual([]);
  });

  test("an unavailable index purges directly exposed entries instead of trusting a stale catalog", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "mars-direct-linear-abc123": { type: "remote", url: "https://den.example.com/mcp/agent/connections/emc_01x" } },
    }));
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      appHostNames: [],
      directNames: [],
      removedNames: ["mars-direct-linear-abc123"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["mars-direct-linear-abc123"]).toBeUndefined();
  });

  test("opportunistically refreshes a stale private catalog from the runtime Cloud endpoint", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01k28e8q8pf8r9sff9mhyqxved";
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "mars-cloud": { type: "remote", url: "https://den.example.com/mcp/agent" },
      },
    }));
    await writeMarsConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://den.example.com/mcp/agent",
    );

    const result = await refreshMarsConnectMcpAppHostCatalog(config, "ws_1", indexFetcher(requests));

    expect(result).toEqual({ status: "synced", appHostNames: [connectMcpAppHostName(connectionId)] });
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer private-app-host-token")).toBe(true);
  });

  test("preserves the last known-good catalog when an opportunistic refresh is unavailable", async () => {
    const config = await fixtureConfig();
    const connectionId = "emc_01lastknowngood";
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "mars-cloud": { type: "remote", url: "https://den.example.com/mcp/agent" },
      },
    }));
    await writeMarsConnectMcpAppHostAuthorization(
      config,
      "ws_1",
      "Bearer private-app-host-token",
      "https://den.example.com/mcp/agent",
    );
    await writeMarsConnectMcpAppHostCatalog(config, "ws_1", {
      schemaVersion: "mars.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Last known good",
        description: null,
        url: `https://den.example.com/mcp/agent/connections/${connectionId}`,
        exposeDirectly: false,
      }],
    });

    const result = await refreshMarsConnectMcpAppHostCatalog(
      config,
      "ws_1",
      async () => new Response(null, { status: 503 }),
    );

    expect(result).toEqual({ status: "unavailable", appHostNames: [] });
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers[0]?.connectionId).toBe(connectionId);
  });

  test("fails closed and purges prior runtime entries when Cloud has no index", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { "mars-connect-existing": { type: "remote", url: "https://cloud.example/existing" } },
    }));
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      fetcher: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "unavailable",
      appHostNames: [],
      directNames: [],
      removedNames: ["mars-connect-existing"],
    });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.["mars-connect-existing"]).toBeUndefined();
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("an empty index removes prior MarsAI-owned provider servers", async () => {
    const config = await fixtureConfig();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        "user-server": { type: "remote", url: "https://user.example/mcp" },
        "mars-connect-existing": { type: "remote", url: "https://cloud.example/existing" },
      },
    }));
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], []),
    });

    expect(result).toEqual({
      status: "synced",
      appHostNames: [],
      directNames: [],
      removedNames: ["mars-connect-existing"],
    });
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.mcp?.["mars-connect-existing"]).toBeUndefined();
    expect(runtime.mcp?.["user-server"]).toEqual({ type: "remote", url: "https://user.example/mcp" });
  });

  test("never sends the persisted App-host credential to an untrusted reconcile endpoint", async () => {
    const config = await fixtureConfig();
    const trustedRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher(trustedRequests),
    });
    expect(trustedRequests.length).toBeGreaterThan(0);

    let untrustedRequests = 0;
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://attacker.example/mcp/agent" },
      fetcher: async () => {
        untrustedRequests += 1;
        return new Response(null, { status: 500 });
      },
    });

    expect(untrustedRequests).toBe(0);
    expect(result.status).toBe("unavailable");
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a catalog that points the private App-host credential at another origin", async () => {
    const config = await fixtureConfig();
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: "https://den.example.com/mcp/agent" },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Untrusted endpoint",
        description: null,
        url: "https://attacker.example/mcp/agent/connections/emc_01crossorigin",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });

  test("rejects a connection proxy on a sibling api origin instead of translating it", async () => {
    const config = await fixtureConfig();
    const result = await reconcileMarsConnectMcpServers({
      config,
      workspace: config.workspaces[0]!,
      cloudMcp: { type: "remote", url: `${DEN}/api/den/mcp/agent` },
      appHostAuthorization: "Bearer private-app-host-token",
      fetcher: indexFetcher([], [{
        connectionId: "emc_01crossorigin",
        name: "Sibling api origin",
        description: null,
        url: "https://api.den.example.com/mcp/agent/connections/emc_01crossorigin",
      }]),
    });

    expect(result).toEqual({ status: "unavailable", appHostNames: [], directNames: [], removedNames: [] });
    expect((await readMarsConnectMcpAppHostCatalog(config, "ws_1")).servers).toEqual([]);
  });
});

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KEYCHAIN_SERVICES,
  accountServerLabel,
  classifyRemoteLogout,
  createDesktopMarsAccountStore,
  legacyKeychainAllowed,
} from "./mars-account.mjs";

function testStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
    decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
  };
}

async function storeOptions(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mars-account-"));
  return {
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => testStorage(),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { MARS_DEV_MODE: "1" },
    sleep: async () => undefined,
    // The macOS keychain tool must never run for a non-darwin store.
    execFileImpl: async (file, args) => {
      throw new Error(`unexpected ${file} ${args.join(" ")}`);
    },
    ...overrides,
  };
}

test("device authorization polls, encrypts, and restores the account", async () => {
  const requests = [];
  let polls = 0;
  const options = await storeOptions({
    fetchImpl: async (url) => {
      requests.push(new URL(url).pathname);
      if (String(url).endsWith("/oauth/userinfo")) {
        return Response.json({
          email: "person@example.com",
          name: "Person",
          tokens_used: 1234,
          token_balance: 98766,
        });
      }
      if (String(url).endsWith("/oauth/device/code")) {
        return Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "http://localhost:5175/console?code=ABCD-EFGH",
          interval: 0,
          expires_in: 60,
        });
      }
      polls += 1;
      if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({
        api_base: "http://127.0.0.1:8000/v1",
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    },
  });
  const opened = [];
  const store = createDesktopMarsAccountStore(options);
  const result = await store.authorize({
    gatewayUrl: undefined,
    deviceName: "Test Mac",
    openVerification: async (url) => { opened.push(url); },
  });
  assert.deepEqual(result, { connected: true, userCode: "ABCD-EFGH", kind: "oauth" });
  assert.deepEqual(opened, ["http://localhost:5175/console?code=ABCD-EFGH"]);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.displayName, "Person");
  assert.match(await readFile(options.filePath, "utf8"), /access-token/);

  const restored = createDesktopMarsAccountStore(options);
  assert.equal((await restored.status()).connected, true);
  assert.deepEqual(requests, [
    "/oauth/device/code",
    "/oauth/token",
    "/oauth/token",
    "/oauth/userinfo",
    "/oauth/userinfo",
  ]);
});

async function authorizeOrigin(env) {
  const requested = [];
  const options = await storeOptions({
    env,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return Response.json({ detail: "unavailable" }, { status: 503 });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  await assert.rejects(store.authorize({ gatewayUrl: undefined, deviceName: "Test Mac", openVerification: async () => undefined }));
  assert.equal(requested.length, 1);
  return requested[0];
}

test("defaults the account service to marsai.click, even in development mode", async () => {
  assert.equal(await authorizeOrigin({}), "https://marsai.click/oauth/device/code");
  assert.equal(await authorizeOrigin({ MARS_DEV_MODE: "1" }), "https://marsai.click/oauth/device/code");
  assert.equal(await authorizeOrigin({ MARS_LOCAL_API: "1" }), "https://marsai.click/oauth/device/code");
});

test("selects the local API only with MARS_DEV_MODE=1 and MARS_LOCAL_API=1", async () => {
  assert.equal(
    await authorizeOrigin({ MARS_DEV_MODE: "1", MARS_LOCAL_API: "1" }),
    "http://127.0.0.1:8000/oauth/device/code",
  );
});

test("an explicit MARS_GATEWAY_URL always wins", async () => {
  assert.equal(
    await authorizeOrigin({ MARS_GATEWAY_URL: "https://staging.example/mars/v1" }),
    "https://staging.example/mars/oauth/device/code",
  );
  assert.equal(
    await authorizeOrigin({ MARS_DEV_MODE: "1", MARS_LOCAL_API: "1", MARS_GATEWAY_URL: "https://staging.example/mars/v1" }),
    "https://staging.example/mars/oauth/device/code",
  );
});

test("MARS_GATEWAY_URL is read when the store is created: deleting it later (the runtime does) keeps sign-in there", async () => {
  const env = { MARS_GATEWAY_URL: "https://staging.example/mars/v1" };
  const requested = [];
  const options = await storeOptions({
    env,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return Response.json({ detail: "unavailable" }, { status: 503 });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  // runtime.mjs clears the account variables before it starts the embedded server.
  delete env.MARS_GATEWAY_URL;
  await assert.rejects(store.authorize({ gatewayUrl: undefined, deviceName: "Test Mac", openVerification: async () => undefined }));
  assert.deepEqual(requested, ["https://staging.example/mars/oauth/device/code"]);
  assert.equal((await store.status()).gatewayUrl, "https://staging.example/mars/v1");
});

test("without an override, sign-in goes to marsai.click even if one appears after startup", async () => {
  const env = {};
  const requested = [];
  const options = await storeOptions({
    env,
    fetchImpl: async (url) => {
      requested.push(String(url));
      return Response.json({ detail: "unavailable" }, { status: 503 });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  // The runtime copies a child environment into process.env; it never redirects the account service.
  env.MARS_GATEWAY_URL = "https://elsewhere.example/mars/v1";
  await assert.rejects(store.authorize({ gatewayUrl: undefined, deviceName: "Test Mac", openVerification: async () => undefined }));
  assert.deepEqual(requested, ["https://marsai.click/oauth/device/code"]);
});

test("profile lookup refreshes an expired device credential and persists the rotation", async () => {
  const options = await storeOptions({
    env: {
      MARS_DEV_MODE: "1",
      MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
      MARS_ACCESS_TOKEN: "expired-access",
      MARS_REFRESH_TOKEN: "current-refresh",
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/userinfo")) {
        const authorization = new Headers(init.headers).get("authorization");
        if (authorization === "Bearer expired-access") {
          return Response.json({ detail: "device_token_invalid" }, { status: 401 });
        }
        assert.equal(authorization, "Bearer rotated-access");
        return Response.json({
          email: "person@example.com",
          name: "Person",
          tokens_used: 12,
          token_balance: 99988,
        });
      }
      if (pathname.endsWith("/oauth/token")) {
        assert.equal(new Headers(init.headers).get("content-type"), "application/x-www-form-urlencoded");
        assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
          grant_type: "refresh_token",
          refresh_token: "current-refresh",
          client_id: "marscli",
        });
        return Response.json({
          api_base: "http://127.0.0.1:8000/v1",
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
        });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  const store = createDesktopMarsAccountStore(options);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.credentialKind, "oauth");
  assert.equal(status.email, "person@example.com");
  assert.equal(status.displayName, "Person");
  assert.equal(status.usage.remainingTokens, 99988);
  assert.equal(status.usage.usedTokens, 12);
  assert.match(await readFile(options.filePath, "utf8"), /rotated-refresh/);
});

test("status carries the userinfo balances the account server sent", async () => {
  const options = await storeOptions({
    env: {
      MARS_DEV_MODE: "1",
      MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
      MARS_ACCESS_TOKEN: "access",
      MARS_REFRESH_TOKEN: "refresh",
    },
    fetchImpl: async (url) => {
      assert.match(new URL(url).pathname, /\/oauth\/userinfo$/);
      return Response.json({
        email: "person@example.com",
        name: "Person",
        tokens_used: 6_800_000,
        token_balance: 3_700_000,
        balance: 500_000,
        free_credits: 1_000,
      });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  const status = await store.status();
  assert.deepEqual(status.usage, {
    tokenLimit: 0,
    usedTokens: 6_800_000,
    remainingTokens: 3_700_000,
    period: "day",
    grantModel: null,
    limitScope: null,
    day: null,
    week: null,
    pot: 500_000,
  });
});

test("sign out prevents legacy credentials from being imported again", async () => {
  let revokeBody = null;
  const options = await storeOptions({
    env: {
      MARS_DEV_MODE: "1",
      MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
      MARS_ACCESS_TOKEN: "legacy-access",
      MARS_REFRESH_TOKEN: "legacy-refresh",
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/userinfo")) {
        return Response.json({
          email: "person@example.com",
          status: "active",
        });
      }
      if (pathname.endsWith("/oauth/revoke")) {
        assert.equal(new Headers(init.headers).get("content-type"), "application/x-www-form-urlencoded");
        revokeBody = Object.fromEntries(new URLSearchParams(init.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const store = createDesktopMarsAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  assert.equal(result.remoteRevoked, true);
  assert.deepEqual(revokeBody, { token: "legacy-refresh", client_id: "marscli" });
  const restarted = createDesktopMarsAccountStore(options);
  assert.equal((await restarted.status()).connected, false);
});

test("sign out clears the local account when remote revocation is unavailable", async () => {
  const options = await storeOptions({
    env: {
      MARS_DEV_MODE: "1",
      MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
      MARS_ACCESS_TOKEN: "legacy-access",
      MARS_REFRESH_TOKEN: "legacy-refresh",
    },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/oauth/revoke")) throw new Error("offline");
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  assert.equal(result.remoteRevoked, false);
  assert.equal((await createDesktopMarsAccountStore(options).status()).connected, false);
});

test("marks an irrecoverably expired device session as signed out", async () => {
  const options = await storeOptions({
    env: {
      MARS_DEV_MODE: "1",
      MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
      MARS_ACCESS_TOKEN: "expired-access",
      MARS_REFRESH_TOKEN: "expired-refresh",
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/userinfo") || pathname.endsWith("/oauth/token")) {
        return Response.json({ detail: "device_token_invalid" }, { status: 401 });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
});

test("rejects an insecure non-loopback account endpoint", async () => {
  let requested = false;
  const options = await storeOptions({
    fetchImpl: async () => {
      requested = true;
      return Response.json({});
    },
  });
  const store = createDesktopMarsAccountStore(options);
  await assert.rejects(
    store.authorize({
      gatewayUrl: "http://example.com/mars/v1",
      deviceName: "Test Mac",
      openVerification: async () => undefined,
    }),
    /not configured/,
  );
  assert.equal(requested, false);
});

const LEGACY_ENV = {
  MARS_DEV_MODE: "1",
  MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1",
  MARS_ACCESS_TOKEN: "legacy-access",
  MARS_REFRESH_TOKEN: "legacy-refresh",
};

async function signOutWith(logoutResponse) {
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/oauth/revoke")) return logoutResponse();
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  assert.equal((await store.status()).connected, true);
  const result = await store.clear();
  // Whatever the server said, the local account is gone and stays gone.
  assert.equal((await createDesktopMarsAccountStore(options).status()).connected, false);
  return result;
}

test("sign out reports which remote revocation outcome happened", async () => {
  assert.deepEqual(await signOutWith(() => new Response(null, { status: 204 })), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(await signOutWith(() => Response.json({ ok: true }, { status: 200 })), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_token_invalid" }, { status: 401 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_session_revoked" }, { status: 403 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  // A 404 that names the session comes from a server that knows the route.
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "device_session_not_found" }, { status: 404 })),
    { remoteRevoked: true, reason: "already_revoked" },
  );
  // FastAPI's default 404 body and a proxy's HTML page mean the route is missing.
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "Not Found" }, { status: 404 })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => new Response("<html><body>404</body></html>", { status: 404, headers: { "content-type": "text/html" } })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "Method Not Allowed" }, { status: 405 })),
    { remoteRevoked: false, reason: "endpoint_missing" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: "maintenance" }, { status: 503 })),
    { remoteRevoked: false, reason: "unreachable" },
  );
  assert.deepEqual(
    await signOutWith(() => Response.json({ detail: [{ msg: "field required" }] }, { status: 422 })),
    { remoteRevoked: false, reason: "unreachable" },
  );
  assert.deepEqual(
    await signOutWith(() => { throw new Error("offline"); }),
    { remoteRevoked: false, reason: "unreachable" },
  );
});

test("classifyRemoteLogout covers the status matrix without a response body", () => {
  assert.deepEqual(classifyRemoteLogout(204), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(classifyRemoteLogout(401), { remoteRevoked: true, reason: "already_revoked" });
  assert.deepEqual(classifyRemoteLogout(404), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(404, "not found."), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(404, "device_session_not_found"), { remoteRevoked: true, reason: "already_revoked" });
  assert.deepEqual(classifyRemoteLogout(501), { remoteRevoked: false, reason: "endpoint_missing" });
  assert.deepEqual(classifyRemoteLogout(500), { remoteRevoked: false, reason: "unreachable" });
  assert.deepEqual(classifyRemoteLogout(429), { remoteRevoked: false, reason: "unreachable" });
});

test("server-driven invalidation reports an already revoked session without a logout call", async () => {
  let logoutCalls = 0;
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/oauth/revoke")) logoutCalls += 1;
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  assert.equal((await store.status()).connected, true);
  assert.deepEqual(await store.clear({ revokeRemote: false }), { remoteRevoked: true, reason: "already_revoked" });
  assert.equal(logoutCalls, 0);
  assert.equal((await createDesktopMarsAccountStore(options).status()).connected, false);
});

function fakeMacKeychain(initial) {
  const items = new Map(Object.entries(initial));
  const calls = [];
  const execFileImpl = async (file, args) => {
    assert.equal(file, "/usr/bin/security");
    calls.push(args);
    const service = args[args.indexOf("-s") + 1];
    if (args[0] === "find-generic-password") {
      if (items.has(service)) return { stdout: `${items.get(service)}\n`, stderr: "" };
    } else if (args[0] === "delete-generic-password") {
      if (items.delete(service)) return { stdout: "", stderr: "" };
    } else {
      throw new Error(`unexpected security ${args.join(" ")}`);
    }
    throw Object.assign(new Error("The specified item could not be found in the keychain."), { code: 44 });
  };
  return { items, calls, execFileImpl };
}

test("sign out on macOS forgets the keychain gateway URL so the next sign-in uses the default server", async () => {
  const keychain = fakeMacKeychain({ [KEYCHAIN_SERVICES.gatewayUrl]: "https://staging.example/mars/v1" });
  const logoutRequests = [];
  const options = await storeOptions({
    platform: "darwin",
    legacyKeychain: true,
    execFileImpl: keychain.execFileImpl,
    env: { MARS_DEV_MODE: "1", MARS_ACCESS_TOKEN: "legacy-access", MARS_REFRESH_TOKEN: "legacy-refresh" },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/oauth/revoke")) {
        logoutRequests.push(String(url));
        return new Response(null, { status: 204 });
      }
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });

  const store = createDesktopMarsAccountStore(options);
  const before = await store.status();
  assert.equal(before.connected, true);
  assert.equal(before.gatewayUrl, "https://staging.example/mars/v1");
  assert.equal(before.gatewayHost, "staging.example");

  assert.deepEqual(await store.clear(), { remoteRevoked: true, reason: "revoked" });
  assert.deepEqual(logoutRequests, ["https://staging.example/mars/oauth/revoke"]);
  const deletes = keychain.calls.filter((args) => args[0] === "delete-generic-password");
  assert.deepEqual(deletes, [["delete-generic-password", "-s", KEYCHAIN_SERVICES.gatewayUrl], ["delete-generic-password", "-s", KEYCHAIN_SERVICES.gatewayUrl]]);
  assert.equal(keychain.items.has(KEYCHAIN_SERVICES.gatewayUrl), false);

  const after = await createDesktopMarsAccountStore(options).status();
  assert.equal(after.connected, false);
  assert.equal(after.gatewayUrl, "https://marsai.click/v1");
  assert.equal(after.gatewayHost, "marsai.click");
});

test("sign out removes every duplicate keychain gateway URL item", async () => {
  let copies = 3;
  const calls = [];
  const options = await storeOptions({
    platform: "darwin",
    legacyKeychain: true,
    execFileImpl: async (_file, args) => {
      calls.push(args);
      if (args[0] === "find-generic-password") throw new Error("not found");
      if (copies > 0) {
        copies -= 1;
        return { stdout: "", stderr: "" };
      }
      throw new Error("not found");
    },
    env: LEGACY_ENV,
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const store = createDesktopMarsAccountStore(options);
  await store.status();
  await store.clear();
  assert.equal(calls.filter((args) => args[0] === "delete-generic-password").length, 4);
  assert.equal(copies, 0);
});

test("server-driven invalidation keeps the keychain gateway URL", async () => {
  const keychain = fakeMacKeychain({ [KEYCHAIN_SERVICES.gatewayUrl]: "https://staging.example/mars/v1" });
  const options = await storeOptions({
    platform: "darwin",
    legacyKeychain: true,
    execFileImpl: keychain.execFileImpl,
    env: { MARS_DEV_MODE: "1", MARS_ACCESS_TOKEN: "expired-access", MARS_REFRESH_TOKEN: "expired-refresh" },
    fetchImpl: async () => Response.json({ detail: "device_token_invalid" }, { status: 401 }),
  });
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(status.gatewayHost, "staging.example");
  assert.equal(keychain.calls.some((args) => args[0] === "delete-generic-password"), false);
  assert.equal(keychain.items.get(KEYCHAIN_SERVICES.gatewayUrl), "https://staging.example/mars/v1");
});

test("only the default production profile imports the legacy keychain account", async () => {
  const signedIn = {
    [KEYCHAIN_SERVICES.gatewayUrl]: "https://marsai.click/v1",
    [KEYCHAIN_SERVICES.accessToken]: "real-access",
    [KEYCHAIN_SERVICES.refreshToken]: "real-refresh",
  };
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return new URL(url).pathname.endsWith("/oauth/revoke")
      ? new Response(null, { status: 204 })
      : Response.json({ email: "owner@example.com", status: "active" });
  };

  // A custom profile (an eval, a test, a dev or blank-slate one) on the owner's Mac.
  const keychain = fakeMacKeychain(signedIn);
  const isolated = createDesktopMarsAccountStore(await storeOptions({ platform: "darwin", env: {}, execFileImpl: keychain.execFileImpl, fetchImpl }));
  const status = await isolated.status();
  assert.equal(status.connected, false);
  assert.equal(status.gatewayUrl, "https://marsai.click/v1");
  await isolated.clear();
  assert.deepEqual(keychain.calls, []);
  assert.deepEqual(requests, []);
  assert.equal(keychain.items.size, 3);

  // The default production profile still imports it once.
  const production = createDesktopMarsAccountStore(await storeOptions({ platform: "darwin", env: {}, legacyKeychain: true, execFileImpl: keychain.execFileImpl, fetchImpl }));
  assert.equal((await production.status()).connected, true);
  assert.deepEqual(requests, ["https://marsai.click/oauth/userinfo"]);
});

test("legacyKeychainAllowed admits the default production profile alone", () => {
  const production = { appIdentifier: "ai.marsai.desktop", productionAppIdentifier: "ai.marsai.desktop", blankSlate: false };
  assert.equal(legacyKeychainAllowed({ ...production, env: {} }), true);
  assert.equal(legacyKeychainAllowed({ ...production, env: { MARS_ELECTRON_USERDATA: "  " } }), true);
  const refused = {
    "dev identifier": { ...production, appIdentifier: "ai.marsai.desktop.dev", env: {} },
    "eval identifier": { ...production, appIdentifier: "ai.marsai.desktop.eval.search", env: {} },
    "blank slate": { ...production, blankSlate: true, env: {} },
    "userData override": { ...production, env: { MARS_ELECTRON_USERDATA: "/tmp/eval/electron-userdata" } },
    "identifier override": { ...production, env: { MARS_ELECTRON_APP_IDENTIFIER: "ai.marsai.desktop" } },
    "mock keychain": { ...production, env: { MARS_ELECTRON_USE_MOCK_KEYCHAIN: "1" } },
  };
  for (const [label, launch] of Object.entries(refused)) assert.equal(legacyKeychainAllowed(launch), false, label);
});

test("status names the account server the app is connected to", async () => {
  const publicStore = createDesktopMarsAccountStore(await storeOptions({ env: {} }));
  assert.deepEqual(await publicStore.status(), {
    connected: false,
    gatewayConfigured: true,
    gatewayUrl: "https://marsai.click/v1",
    gatewayHost: "marsai.click",
  });

  const localStore = createDesktopMarsAccountStore(await storeOptions({ env: { MARS_DEV_MODE: "1", MARS_LOCAL_API: "1" } }));
  const local = await localStore.status();
  assert.equal(local.gatewayUrl, "http://127.0.0.1:8000/v1");
  assert.equal(local.gatewayHost, "127.0.0.1:8000 (local API)");

  const connectedStore = createDesktopMarsAccountStore(await storeOptions({
    env: { ...LEGACY_ENV, MARS_GATEWAY_URL: "https://api.example:8443/mars/v1" },
    fetchImpl: async () => Response.json({ email: "person@example.com", status: "active" }),
  }));
  const connected = await connectedStore.status();
  assert.equal(connected.connected, true);
  assert.equal(connected.gatewayUrl, "https://api.example:8443/mars/v1");
  assert.equal(connected.gatewayHost, "api.example:8443");
});

test("accountServerLabel marks loopback servers as the local API", () => {
  assert.equal(accountServerLabel("https://marsai.click/v1"), "marsai.click");
  assert.equal(accountServerLabel("https://marsai.click:443/mars/v1/"), "marsai.click");
  assert.equal(accountServerLabel("https://api.example:8443/mars/v1"), "api.example:8443");
  assert.equal(accountServerLabel("http://127.0.0.1:8000/v1"), "127.0.0.1:8000 (local API)");
  assert.equal(accountServerLabel("http://127.0.0.1:8090/mars/v1"), "127.0.0.1:8090 (local API)");
  assert.equal(accountServerLabel("http://example.com/mars/v1"), null);
  assert.equal(accountServerLabel(""), null);
  assert.equal(accountServerLabel(null), null);
});

// This store is the one owner of the device session's refresh token: the
// embedded broker asks store.refresh() after a 401 instead of refreshing on
// its own (runtime.mjs). The account server accepts the refresh token its
// latest rotation replaced for 120 s; any other superseded token it receives
// reads as a sign-in copied to another device, so the store never sends one.

const SHARED_GATEWAY_URL = "https://gateway.example/mars/v1";
const SERVER_GRACE_MS = 120_000;

/** A test clock: the store's `now`, and a `sleep` that moves it forward. */
function testClock(start = 1_700_000_000_000) {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (milliseconds) => { clock.t += milliseconds; },
  };
  return clock;
}

/**
 * Fake account server with the backend's rotation rules: a rotation demotes
 * the token it spent to `previous`, still accepted for 120 s (a grace
 * rotation, from the current token), and retires the one before. A token
 * past its grace (previous, or retired longer than 120 s ago) is refused and
 * recorded in `superseded`: the backend's copied-sign-in signal.
 */
function fakeAccountServer(clock = testClock()) {
  const server = {
    access: "access-1",
    refresh: "refresh-1",
    previous: null,
    previousAt: 0,
    retired: new Map(),
    generation: 1,
    expired: new Set(),
    refreshCalls: [],
    refreshTimes: [],
    superseded: [],
    holdProfile: null,
    holdRefresh: null,
    holdLogout: null,
    /** Rotate, then lose the answer this many times (the request times out). */
    loseNext: 0,
    /** Time out this many times before the request is handled (nothing rotates). */
    stallNext: 0,
    /** Answer the next refresh with this status before looking at the token. */
    answerNext: null,
    /** Rotate, then never answer: the app is gone (crash, quit) before the answer. */
    hangNext: false,
  };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const bearer = new Headers(init.headers).get("authorization")?.slice(7) ?? "";
    if (pathname.endsWith("/oauth/userinfo")) {
      if (server.holdProfile) await server.holdProfile;
      return bearer === server.access && !server.expired.has(bearer)
        ? Response.json({ email: "person@example.com", status: "active" })
        : Response.json({ detail: "device_token_invalid" }, { status: 401 });
    }
    if (pathname.endsWith("/oauth/token")) {
      const token = new URLSearchParams(init.body).get("refresh_token") ?? "";
      server.refreshCalls.push(token);
      server.refreshTimes.push(clock.now());
      // Held before the check, so a test can act while the request is in flight.
      const hold = server.holdRefresh;
      server.holdRefresh = null;
      if (hold) await hold;
      if (server.stallNext > 0) {
        server.stallNext -= 1;
        clock.t += 20_000;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (server.answerNext) {
        const status = server.answerNext;
        server.answerNext = null;
        return Response.json({ detail: "unavailable" }, { status });
      }
      const inGrace = token === server.previous && clock.now() - server.previousAt <= SERVER_GRACE_MS;
      if (token !== server.refresh && !inGrace) {
        const supersededAt = token === server.previous ? server.previousAt : server.retired.get(token);
        if (supersededAt !== undefined && clock.now() - supersededAt > SERVER_GRACE_MS) server.superseded.push(token);
        return Response.json({ detail: "refresh_token_invalid_or_expired" }, { status: 401 });
      }
      if (server.previous) server.retired.set(server.previous, clock.now());
      server.previous = server.refresh;
      server.previousAt = clock.now();
      server.generation += 1;
      server.access = `access-${server.generation}`;
      server.refresh = `refresh-${server.generation}`;
      if (server.hangNext) {
        server.hangNext = false;
        return new Promise(() => {});
      }
      if (server.loseNext > 0) {
        server.loseNext -= 1;
        clock.t += 20_000;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return Response.json({ access_token: server.access, refresh_token: server.refresh });
    }
    if (pathname.endsWith("/oauth/revoke")) {
      if (server.holdLogout) await server.holdLogout;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  return { server, fetchImpl };
}

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const tick = (milliseconds = 5) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function connectedStore(fetchImpl, overrides = {}) {
  const options = await storeOptions({ fetchImpl, ...overrides });
  const store = createDesktopMarsAccountStore(options);
  await store.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1" });
  return { store, options };
}

const refreshingFile = (options) => `${options.filePath}.refreshing`;

test("concurrent refreshes spend the refresh token once and all get the rotated pair", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  server.expired.add("access-1");
  const refresh = deferred();
  server.holdRefresh = refresh.promise;
  // The broker (twice) and the profile check all see access-1 refused at once.
  const callers = [store.refresh("access-1"), store.refresh("access-1"), store.status()];
  await tick();
  refresh.resolve();
  const [first, second, status] = await Promise.all(callers);
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
  assert.equal(first.accessToken, "access-2");
  assert.deepEqual(second, first);
  assert.equal(status.email, "person@example.com");
  assert.deepEqual(await store.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", kind: "oauth", rotation: 1 });
});

test("a caller refused with an access token that was already rotated gets the current pair without a request", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  assert.equal((await store.refresh("access-1")).accessToken, "access-2");
  // The broker still held access-1 when it was refused.
  assert.equal((await store.refresh("access-1")).accessToken, "access-2");
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
});

test("a profile check whose token the broker's refresh replaced meanwhile uses the new pair without a request", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  server.expired.add("access-1");
  const profile = deferred();
  server.holdProfile = profile.promise;
  const status = store.status(); // GET /oauth/userinfo with the expired token is now in flight
  await tick();
  assert.equal((await store.refresh("access-1")).accessToken, "access-2"); // the broker's 401
  server.holdProfile = null;
  profile.resolve();
  const result = await status;
  assert.equal(result.connected, true);
  assert.equal(result.email, "person@example.com");
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
});

test("load() waits for a rotation in flight so the broker reads the settled pair", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const slowStorage = {
    ...testStorage(),
    encryptStringAsync: async (value) => {
      await tick(20);
      return Buffer.from(value, "utf8");
    },
  };
  const { store } = await connectedStore(fetchImpl, { loadSafeStorage: () => slowStorage });
  server.expired.add("access-1");
  const refresh = deferred();
  server.holdRefresh = refresh.promise;
  const status = store.status();
  await tick();
  const latest = store.load(); // the broker's latest(), asked mid-rotation
  refresh.resolve();
  assert.deepEqual(await latest, { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", kind: "oauth", rotation: 1 });
  assert.equal((await status).connected, true);
});

test("a lost refresh answer is sent again with the same token inside the grace and converges", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const logs = [];
  const { store, options } = await connectedStore(fetchImpl, { now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
  server.loseNext = 1; // the server rotates, the answer times out
  const rotated = await store.refresh("access-1");
  // refresh-1 again, within the grace: the server rotates once more from the current token.
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-1"]);
  assert.equal(server.refreshTimes[1] - server.refreshTimes[0] <= 100_000, true);
  assert.deepEqual(server.superseded, []);
  assert.equal(rotated.refreshToken, server.refresh);
  assert.deepEqual(await createDesktopMarsAccountStore(options).load(), rotated);
  assert.equal(await exists(refreshingFile(options)), false);
  assert.equal(logs.some((line) => /same token again/.test(line)), true);
  assert.equal(logs.some((line) => line.includes("refresh-") || line.includes("access-")), false);
});

test("a 409 while the token is being rotated is sent again inside the grace, never signed out", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const { store } = await connectedStore(fetchImpl, { now: clock.now, sleep: clock.sleep });
  server.expired.add("access-1");
  server.answerNext = 409;
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.email, "person@example.com");
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-1"]);
  assert.deepEqual(server.superseded, []);
});

test("a refresh answer lost past the grace: the token is never sent again and the user signs in again", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const logs = [];
  const { store, options } = await connectedStore(fetchImpl, { now: clock.now, sleep: clock.sleep, log: (line) => logs.push(line) });
  server.stallNext = 100; // no answer ever arrives
  assert.equal(await store.refresh("access-1"), null);
  const first = server.refreshTimes[0];
  assert.equal(server.refreshCalls.every((token) => token === "refresh-1"), true);
  // Each attempt starts early enough to end (20 s timeout) inside the server's 120 s grace.
  assert.equal(server.refreshTimes.every((time) => time - first <= 100_000), true);
  assert.deepEqual(server.superseded, []);
  const sent = server.refreshCalls.length;
  const status = await store.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(await store.refresh("access-1"), null);
  assert.equal(server.refreshCalls.length, sent);
  // A restart does not bring it back.
  assert.equal(await createDesktopMarsAccountStore(options).load(), null);
  assert.equal(server.refreshCalls.length, sent);
  assert.equal(logs.some((line) => /grace for sending it again ran out/.test(line)), true);
});

/** Starts a refresh whose answer never arrives: the app is gone before it lands. */
async function crashMidRefresh(overrides = {}) {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const { store, options } = await connectedStore(fetchImpl, { now: clock.now, sleep: clock.sleep, ...overrides });
  server.hangNext = true;
  void store.refresh("access-1");
  while (server.refreshCalls.length === 0) await tick(1);
  // The record was on disk before the token was sent; the server rotated.
  const record = JSON.parse(await readFile(refreshingFile(options), "utf8"));
  assert.equal(record.firstSentAt, clock.t);
  assert.equal(JSON.stringify(record).includes("refresh-1"), false);
  return { clock, server, options };
}

test("a restart after the grace never presents the token a crash left in flight; the user signs in again", async () => {
  const { clock, server, options } = await crashMidRefresh();
  clock.t += SERVER_GRACE_MS + 30_000;
  const restarted = createDesktopMarsAccountStore(options);
  assert.equal(await restarted.load(), null);
  const status = await restarted.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
  assert.deepEqual(server.superseded, []);
  assert.equal(await exists(options.filePath), false);
  assert.equal(await exists(refreshingFile(options)), false);
});

test("a restart inside the grace finishes the refresh a crash cut off, with the same token", async () => {
  const { clock, server, options } = await crashMidRefresh();
  clock.t += 30_000;
  const restarted = createDesktopMarsAccountStore(options);
  assert.equal((await restarted.load()).refreshToken, "refresh-1");
  // Sent again at once, while the server still accepts it.
  const current = await restarted.refresh("access-1");
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-1"]);
  assert.equal(current.refreshToken, server.refresh);
  assert.deepEqual(server.superseded, []);
  assert.equal(await exists(refreshingFile(options)), false);
});

/** A store whose secure storage fails once `broken.value` is set. */
function breakableStorage(broken) {
  return {
    ...testStorage(),
    encryptStringAsync: async (value) => {
      if (broken.value) throw new Error("Secure desktop credential storage is unavailable");
      return Buffer.from(value, "utf8");
    },
  };
}

test("a failed save keeps the rotated pair in use, retries and logs it, and never sends the pair it replaced", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const logs = [];
  const broken = { value: false };
  const { store, options } = await connectedStore(fetchImpl, {
    now: clock.now,
    sleep: clock.sleep,
    loadSafeStorage: () => breakableStorage(broken),
    log: (line) => logs.push(line),
    persistRetryBaseMs: 5,
  });
  broken.value = true;
  server.expired.add("access-1");
  assert.equal((await store.status()).email, "person@example.com");
  // The new pair is the truth in memory; the disk still has the old one.
  assert.equal((await store.load()).refreshToken, "refresh-2");
  assert.match(await readFile(options.filePath, "utf8"), /refresh-1/);
  await tick(40);
  assert.equal(logs.filter((line) => /Could not save the renewed marsai\.click sign-in/.test(line)).length > 1, true);

  // An hour later the next rotation spends refresh-2, never refresh-1.
  clock.t += 3_600_000;
  server.expired.add("access-2");
  assert.equal((await store.refresh("access-2")).refreshToken, "refresh-3");
  assert.deepEqual(server.refreshCalls, ["refresh-1", "refresh-2"]);
  assert.deepEqual(server.superseded, []);
  // The pair on disk is two rotations behind now: no restart may send it.
  assert.equal(JSON.parse(await readFile(refreshingFile(options), "utf8")).firstSentAt, 0);

  // Storage comes back: the retry saves the current pair and drops the record.
  broken.value = false;
  for (let waited = 0; waited < 200 && await exists(refreshingFile(options)); waited += 1) await tick(5);
  assert.match(await readFile(options.filePath, "utf8"), /refresh-3/);
  assert.equal(await exists(refreshingFile(options)), false);
  assert.equal((await createDesktopMarsAccountStore(options).load()).refreshToken, "refresh-3");
});

test("a quit or crash between a rotation and its save never presents the replaced token after the grace", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  const broken = { value: false };
  const { store, options } = await connectedStore(fetchImpl, { now: clock.now, sleep: clock.sleep, loadSafeStorage: () => breakableStorage(broken) });
  broken.value = true;
  server.expired.add("access-1");
  assert.equal((await store.status()).connected, true); // rotated to refresh-2, saved nowhere
  // The app is gone; it starts again later with working storage.
  clock.t += SERVER_GRACE_MS + 1;
  const restarted = createDesktopMarsAccountStore({ ...options, loadSafeStorage: () => testStorage() });
  assert.equal(await restarted.load(), null);
  const status = await restarted.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
  assert.deepEqual(server.superseded, []);
});

test("a refresh that never reached the server keeps the pair and leaves nothing to guard", async () => {
  const clock = testClock();
  const { server, fetchImpl } = fakeAccountServer(clock);
  let offline = true;
  const { store, options } = await connectedStore(async (url, init) => {
    if (offline && new URL(url).pathname.endsWith("/oauth/token")) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND gateway.example"), { code: "ENOTFOUND" }) });
    }
    return fetchImpl(url, init);
  }, { now: clock.now, sleep: clock.sleep });
  await assert.rejects(store.refresh("access-1"), /Account refresh unavailable \(ENOTFOUND\)/);
  assert.equal((await store.load()).refreshToken, "refresh-1");
  assert.equal(await exists(refreshingFile(options)), false);
  // Back online much later: refresh-1 was never spent, so it is sent as usual.
  offline = false;
  clock.t += 3_600_000;
  assert.equal((await store.refresh("access-1")).refreshToken, "refresh-2");
  assert.deepEqual(server.refreshCalls, ["refresh-1"]);
});

test("save() never writes a pair rotated fewer times over the current one", async () => {
  const { fetchImpl } = fakeAccountServer();
  const logs = [];
  const { store, options } = await connectedStore(fetchImpl, { log: (line) => logs.push(line) });
  await store.refresh("access-1");
  await store.refresh("access-2");
  assert.equal((await store.load()).rotation, 2);
  await store.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  assert.deepEqual(await store.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-3", refreshToken: "refresh-3", kind: "oauth", rotation: 2 });
  // A fresh process reading the file first refuses it as well.
  const restarted = createDesktopMarsAccountStore(options);
  await restarted.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1" });
  assert.equal((await restarted.load()).refreshToken, "refresh-3");
  assert.equal(logs.some((line) => /was not saved over it/.test(line)), true);
});

test("a saved sign-in this launch cannot read is never replaced by environment or keychain credentials", async () => {
  const requests = [];
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (url) => {
      requests.push(new URL(url).pathname);
      return Response.json({ email: "person@example.com", status: "active" });
    },
    // The keyring that sealed the file is not the one this launch has.
    loadSafeStorage: () => ({ ...testStorage(), decryptStringAsync: async () => { throw new Error("cannot decrypt"); } }),
  });
  await writeFile(options.filePath, "sealed by another keyring");
  const store = createDesktopMarsAccountStore(options);
  assert.equal(await store.load(), null);
  assert.equal((await store.status()).connected, false);
  assert.deepEqual(requests, []);
  assert.equal(await readFile(options.filePath, "utf8"), "sealed by another keyring");
});

test("the legacy keychain pair is imported once and removed, so it can never come back", async () => {
  const keychain = fakeMacKeychain({
    [KEYCHAIN_SERVICES.gatewayUrl]: "https://marsai.click/v1",
    [KEYCHAIN_SERVICES.accessToken]: "old-access",
    [KEYCHAIN_SERVICES.refreshToken]: "old-refresh",
  });
  const options = await storeOptions({
    platform: "darwin",
    env: {},
    legacyKeychain: true,
    execFileImpl: keychain.execFileImpl,
    fetchImpl: async () => Response.json({ email: "person@example.com", status: "active" }),
  });
  assert.equal((await createDesktopMarsAccountStore(options).load()).refreshToken, "old-refresh");
  assert.deepEqual([...keychain.items.keys()], [KEYCHAIN_SERVICES.gatewayUrl]);
});

test("a reader that races the sign-out cannot resurrect the cleared account", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store, options } = await connectedStore(fetchImpl);
  const logout = deferred();
  server.holdLogout = logout.promise;
  const clearing = store.clear();
  await tick();
  const read = store.load(); // the broker's latest(), asked mid-sign-out
  logout.resolve();
  assert.deepEqual(await clearing, { remoteRevoked: true, reason: "revoked" });
  assert.equal(await read, null);
  assert.equal(await store.load(), null);
  assert.equal((await createDesktopMarsAccountStore(options).status()).connected, false);
});

test("a save during a user sign-out is dropped; during a server-driven sign-out it lands", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const { store } = await connectedStore(fetchImpl);
  const logout = deferred();
  server.holdLogout = logout.promise;
  const clearing = store.clear();
  await tick();
  const dropped = store.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  logout.resolve();
  await clearing;
  await dropped;
  assert.equal(await store.load(), null);

  const { store: invalidated } = await connectedStore(fetchImpl);
  const clearingServerDriven = invalidated.clear({ revokeRemote: false });
  const landed = invalidated.save({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", rotation: 1 });
  await clearingServerDriven;
  await landed;
  assert.deepEqual(await invalidated.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-2", refreshToken: "refresh-2", kind: "oauth", rotation: 1 });
});

test("a bundle persisted before the rotation counter loads as rotation 0 and counts from there", async () => {
  const { server, fetchImpl } = fakeAccountServer();
  const options = await storeOptions({ fetchImpl });
  await writeFile(options.filePath, JSON.stringify({ gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1" }));
  const store = createDesktopMarsAccountStore(options);
  assert.deepEqual(await store.load(), { gatewayUrl: SHARED_GATEWAY_URL, accessToken: "access-1", refreshToken: "refresh-1", kind: "oauth", rotation: 0 });
  server.expired.add("access-1");
  assert.equal((await store.status()).email, "person@example.com");
  assert.equal(JSON.parse(await readFile(options.filePath, "utf8")).rotation, 1);
});

// Linux without a usable keyring: the sign-in falls back to an owner-only file.

const FAKE_GATEWAY_URL = "http://127.0.0.1:9/mars/v1";

/** A fake safeStorage reporting `backend`; "encrypts" by prefixing so tests can tell sealed bytes apart. */
function linuxStorage(backend, { available = true } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptStringAsync: async (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed by this keyring");
      return { result: text.slice("sealed:".length), shouldReEncrypt: false };
    },
  };
}

async function fallbackOptions(storage, overrides = {}) {
  const logs = [];
  const options = await storeOptions({
    loadSafeStorage: () => storage,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/userinfo")) return Response.json({ email: "person@example.com", status: "active" });
      if (pathname.endsWith("/oauth/revoke")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${pathname}`);
    },
    log: (message) => logs.push(message),
    ...overrides,
  });
  const fallbackFilePath = path.join(path.dirname(options.filePath), "private-credentials", "account.json");
  return { options: { ...options, fallbackFilePath }, logs };
}

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

const FAKE_CREDENTIALS = { gatewayUrl: FAKE_GATEWAY_URL, accessToken: "fake-access", refreshToken: "fake-refresh" };

test("Linux basic_text: sign-in lands in an owner-only private file instead of failing", async () => {
  let polls = 0;
  const { options, logs } = await fallbackOptions(linuxStorage("basic_text"), {
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/device/code")) {
        return Response.json({ device_code: "code", user_code: "ABCD", verification_uri_complete: "https://marsai.click/console?code=ABCD", interval: 0, expires_in: 60 });
      }
      if (pathname.endsWith("/oauth/token")) {
        polls += 1;
        return Response.json({ api_base: FAKE_GATEWAY_URL, access_token: "fake-access", refresh_token: "fake-refresh" });
      }
      if (pathname.endsWith("/oauth/userinfo")) return Response.json({ email: "person@example.com", status: "active" });
      throw new Error(`Unexpected request ${pathname}`);
    },
  });
  const store = createDesktopMarsAccountStore(options);
  const result = await store.authorize({ gatewayUrl: undefined, deviceName: "Test Linux", openVerification: async () => undefined });
  assert.equal(result.connected, true);
  assert.equal(polls, 1);

  assert.equal(await exists(options.filePath), false);
  const saved = JSON.parse(await readFile(options.fallbackFilePath, "utf8"));
  assert.equal(saved.credentials.refreshToken, "fake-refresh");
  assert.match(saved.note, /Unencrypted at rest/);
  if (process.platform !== "win32") {
    assert.equal((await stat(options.fallbackFilePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(options.fallbackFilePath))).mode & 0o777, 0o700);
  }
  assert.equal(logs.filter((line) => /unencrypted at rest/.test(line)).length <= 1, true);
  assert.equal(logs.some((line) => line.includes("fake-access") || line.includes("fake-refresh")), false);

  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal(status.credentialStorage, "file");
  assert.equal(status.email, "person@example.com");
});

test("Linux without encryption at all also uses the private file", async () => {
  const { options } = await fallbackOptions(linuxStorage("gnome_libsecret", { available: false }));
  const store = createDesktopMarsAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.equal((await store.status()).credentialStorage, "file");
});

test("Linux with libsecret keeps the encrypted keyring path and no private file", async () => {
  const { options } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  const store = createDesktopMarsAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
  assert.equal(await exists(options.fallbackFilePath), false);
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal("credentialStorage" in status, false);
});

test("a keyring that appears later receives the sign-in and the private file is deleted", async () => {
  const { options: plain } = await fallbackOptions(linuxStorage("basic_text"));
  await createDesktopMarsAccountStore(plain).save(FAKE_CREDENTIALS);
  assert.equal(await exists(plain.fallbackFilePath), true);

  const { options, logs } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  Object.assign(options, { filePath: plain.filePath, fallbackFilePath: plain.fallbackFilePath });
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal("credentialStorage" in status, false);
  assert.equal(await exists(options.fallbackFilePath), false);
  const sealed = await readFile(options.filePath, "utf8");
  assert.match(sealed, /^sealed:/);
  assert.equal(JSON.parse(sealed.slice("sealed:".length)).refreshToken, "fake-refresh");
  assert.equal(logs.some((line) => /into the system keyring/.test(line)), true);

  // The next launch reads the keyring copy.
  assert.equal((await createDesktopMarsAccountStore(options).load())?.refreshToken, "fake-refresh");
});

test("a keyring that disappears asks for a new sign-in instead of failing", async () => {
  const { options: sealed } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  await createDesktopMarsAccountStore(sealed).save(FAKE_CREDENTIALS);

  const { options } = await fallbackOptions(linuxStorage("basic_text"));
  Object.assign(options, { filePath: sealed.filePath, fallbackFilePath: sealed.fallbackFilePath });
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(status.credentialStorage, "file");
  assert.equal(status.keyringUnavailable, true);

  // Signing in again works and lands in the private file.
  const store = createDesktopMarsAccountStore(options);
  await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-2" });
  assert.equal((await store.status()).connected, true);
  assert.equal(await exists(options.fallbackFilePath), true);
});

test("sign-out deletes the private file and stays signed out", async () => {
  const { options } = await fallbackOptions(linuxStorage("basic_text"));
  const store = createDesktopMarsAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.deepEqual(await store.clear(), { remoteRevoked: true, reason: "revoked" });
  assert.equal(await exists(options.fallbackFilePath), false);
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, undefined);
});

for (const platform of /** @type {const} */ (["darwin", "win32"])) {
  test(`${platform}: unavailable secure storage keeps the sign-in in the private file`, async () => {
    const { options } = await fallbackOptions(linuxStorage("unknown", { available: false }), { platform });
    const store = createDesktopMarsAccountStore(options);
    await store.save(FAKE_CREDENTIALS);
    assert.equal(await exists(options.fallbackFilePath), true);
    assert.equal(await exists(options.filePath), false);
    const status = await createDesktopMarsAccountStore(options).status();
    assert.equal(status.connected, true);
    assert.equal(status.credentialStorage, "file");
  });

  test(`${platform}: available secure storage is used exactly as before`, async () => {
    const { options } = await fallbackOptions(linuxStorage(platform === "darwin" ? "keychain" : "dpapi"), { platform });
    const store = createDesktopMarsAccountStore(options);
    await store.save(FAKE_CREDENTIALS);
    assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
    assert.equal(await exists(options.fallbackFilePath), false);
    assert.equal("credentialStorage" in await store.status(), false);
  });
}

// Electron's exact rejection when the encryptor started but the keyring gave
// it no key (a denied macOS keychain entry after the app's signature changed).
const ENCRYPT_REFUSED = "Error while encrypting the text provided to safeStorage.encryptStringAsync.";

/** A keyring that reports encryption available, then refuses to encrypt; it counts its attempts. */
function refusingStorage(backend = "unknown") {
  const storage = {
    ...linuxStorage(backend),
    encryptCalls: 0,
    encryptStringAsync: async () => {
      storage.encryptCalls += 1;
      throw new Error(ENCRYPT_REFUSED);
    },
  };
  return storage;
}

for (const platform of /** @type {const} */ (["darwin", "win32", "linux"])) {
  test(`${platform}: a keyring that refuses to encrypt never fails the sign-in`, async () => {
    const storage = refusingStorage(platform === "linux" ? "gnome_libsecret" : "unknown");
    const { options, logs } = await fallbackOptions(storage, {
      platform,
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/oauth/device/code")) {
          return Response.json({ device_code: "code", user_code: "ABCD", verification_uri_complete: "https://marsai.click/console?code=ABCD", interval: 0, expires_in: 60 });
        }
        if (pathname.endsWith("/oauth/token")) return Response.json({ api_base: FAKE_GATEWAY_URL, access_token: "fake-access", refresh_token: "fake-refresh" });
        if (pathname.endsWith("/oauth/userinfo")) return Response.json({ email: "person@example.com", status: "active" });
        throw new Error(`Unexpected request ${pathname}`);
      },
    });
    const store = createDesktopMarsAccountStore(options);
    const result = await store.authorize({ gatewayUrl: undefined, deviceName: "Test", openVerification: async () => undefined });
    assert.equal(result.connected, true);

    const saved = JSON.parse(await readFile(options.fallbackFilePath, "utf8"));
    assert.equal(saved.credentials.refreshToken, "fake-refresh");
    if (process.platform !== "win32") assert.equal((await stat(options.fallbackFilePath)).mode & 0o777, 0o600);
    assert.equal(await exists(options.filePath), false);
    assert.equal(logs.filter((line) => line.includes(ENCRYPT_REFUSED)).length, 1);
    assert.equal(logs.some((line) => line.includes("fake-access") || line.includes("fake-refresh")), false);

    const status = await store.status();
    assert.equal(status.connected, true);
    assert.equal(status.credentialStorage, "file");

    // The keyring is asked once per launch: a rotation saves straight to the file.
    await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-2", rotation: 1 });
    assert.equal(storage.encryptCalls, 1);
    assert.equal(JSON.parse(await readFile(options.fallbackFilePath, "utf8")).credentials.refreshToken, "fake-refresh-2");

    // The next launch, still refused, reads the file and stays signed in.
    const relaunched = createDesktopMarsAccountStore({ ...options, loadSafeStorage: () => refusingStorage() });
    assert.equal((await relaunched.load())?.refreshToken, "fake-refresh-2");
    assert.equal(await exists(options.fallbackFilePath), true);
  });
}

test("after an update the old keyring copy cannot be decrypted: signed out, then sign-in works", async () => {
  // Sealed by the previous build's keychain identity.
  const { options: before } = await fallbackOptions(linuxStorage("unknown"), { platform: "darwin" });
  await createDesktopMarsAccountStore(before).save(FAKE_CREDENTIALS);
  assert.match(await readFile(before.filePath, "utf8"), /^sealed:/);

  // The updated app: decrypt fails, and encrypt is refused too.
  const storage = refusingStorage();
  storage.decryptStringAsync = async () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync."); };
  const { options, logs } = await fallbackOptions(storage, { platform: "darwin" });
  Object.assign(options, { filePath: before.filePath, fallbackFilePath: before.fallbackFilePath });
  const store = createDesktopMarsAccountStore(options);
  const status = await store.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(logs.some((line) => /cannot be decrypted/.test(line)), true);

  await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-new" });
  assert.equal((await store.status()).connected, true);
  // The old pair is gone for good: no later launch can read it back.
  assert.equal(await exists(options.filePath), false);
  assert.equal(JSON.parse(await readFile(options.fallbackFilePath, "utf8")).credentials.refreshToken, "fake-refresh-new");
});

test("an undecryptable keyring copy with a working keyring asks to sign in again, and the new sign-in is sealed", async () => {
  const { options: before } = await fallbackOptions(linuxStorage("unknown"), { platform: "darwin" });
  await createDesktopMarsAccountStore(before).save(FAKE_CREDENTIALS);
  const storage = linuxStorage("unknown");
  const original = storage.decryptStringAsync;
  let rotatedKey = false;
  storage.decryptStringAsync = async (value) => {
    if (!rotatedKey) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.");
    return original(value);
  };
  const { options } = await fallbackOptions(storage, { platform: "darwin" });
  Object.assign(options, { filePath: before.filePath, fallbackFilePath: before.fallbackFilePath });
  const store = createDesktopMarsAccountStore(options);
  const status = await store.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal("credentialStorage" in status, false);

  rotatedKey = true;
  await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-new" });
  assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
  assert.equal(await exists(options.fallbackFilePath), false);
  assert.equal((await store.status()).connected, true);
});

test("a keyring that works again on a later launch receives the sign-in from the private file", async () => {
  const { options } = await fallbackOptions(refusingStorage(), { platform: "darwin" });
  await createDesktopMarsAccountStore(options).save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);

  const logs = [];
  const healed = createDesktopMarsAccountStore({ ...options, loadSafeStorage: () => linuxStorage("unknown"), log: (line) => logs.push(line) });
  assert.equal((await healed.load())?.refreshToken, "fake-refresh");
  assert.match(await readFile(options.filePath, "utf8"), /^sealed:/);
  assert.equal(await exists(options.fallbackFilePath), false);
  assert.equal(logs.some((line) => /into the system keyring/.test(line)), true);
});

test("a keyring that throws while reporting availability counts as unusable", async () => {
  const storage = { ...linuxStorage("unknown"), isAsyncEncryptionAvailable: async () => { throw new Error("safeStorage cannot be used before app is ready"); } };
  const { options } = await fallbackOptions(storage, { platform: "darwin" });
  const store = createDesktopMarsAccountStore(options);
  await store.save(FAKE_CREDENTIALS);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.equal((await store.status()).connected, true);
});

test("without a private file path a refusing keyring still fails the save, naming the cause", async () => {
  const options = await storeOptions({ platform: "darwin", loadSafeStorage: () => refusingStorage() });
  await assert.rejects(
    createDesktopMarsAccountStore(options).save(FAKE_CREDENTIALS),
    /Secure desktop credential storage is unavailable: Error while encrypting/,
  );
});

test("Linux basic_text without a fallback path keeps refusing (no silent plaintext)", async () => {
  const options = await storeOptions({ loadSafeStorage: () => linuxStorage("basic_text") });
  await assert.rejects(
    createDesktopMarsAccountStore(options).save(FAKE_CREDENTIALS),
    /Secure desktop credential storage is unavailable/,
  );
});

test("migration keeps the private file until the keyring copy reads back, and the user stays signed in", async () => {
  const { options: plain } = await fallbackOptions(linuxStorage("basic_text"));
  await createDesktopMarsAccountStore(plain).save(FAKE_CREDENTIALS);

  // A keyring that encrypts but cannot return what it sealed (locked, half-started).
  const broken = { ...linuxStorage("gnome_libsecret"), decryptStringAsync: async () => { throw new Error("locked"); } };
  const recorded = [];
  const { options, logs } = await fallbackOptions(broken, { onKeyringSealed: (backend) => { recorded.push(backend); } });
  Object.assign(options, { filePath: plain.filePath, fallbackFilePath: plain.fallbackFilePath });
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, true);
  assert.equal(await exists(options.fallbackFilePath), true);
  assert.equal(JSON.parse(await readFile(options.fallbackFilePath, "utf8")).credentials.refreshToken, "fake-refresh");
  assert.deepEqual(recorded, []);
  assert.equal(logs.some((line) => /did not return/.test(line)), true);
  assert.equal(logs.some((line) => line.includes("fake-access") || line.includes("fake-refresh")), false);

  // A rotation saved while the keyring cannot read back also stays in the file.
  const store = createDesktopMarsAccountStore(options);
  await store.save({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-2" });
  assert.equal(JSON.parse(await readFile(options.fallbackFilePath, "utf8")).credentials.refreshToken, "fake-refresh-2");

  // Once the keyring works, the copy is verified, the file deleted and the store recorded.
  const { options: working } = await fallbackOptions(linuxStorage("gnome_libsecret"), { onKeyringSealed: (backend) => { recorded.push(backend); } });
  Object.assign(working, { filePath: plain.filePath, fallbackFilePath: plain.fallbackFilePath });
  assert.equal((await createDesktopMarsAccountStore(working).load())?.refreshToken, "fake-refresh-2");
  assert.equal(await exists(working.fallbackFilePath), false);
  assert.deepEqual(recorded, ["gnome_libsecret"]);
});

test("a leftover private file older than a readable keyring copy never replaces it", async () => {
  const { options } = await fallbackOptions(linuxStorage("gnome_libsecret"));
  const { options: plain } = await fallbackOptions(linuxStorage("basic_text"));
  Object.assign(plain, { filePath: options.filePath, fallbackFilePath: options.fallbackFilePath });
  await createDesktopMarsAccountStore(plain).save(FAKE_CREDENTIALS);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  // The keyring copy holds a newer rotation (its delete of the file failed).
  await writeFile(options.filePath, `sealed:${JSON.stringify({ ...FAKE_CREDENTIALS, refreshToken: "fake-refresh-newer" })}`);
  assert.equal((await createDesktopMarsAccountStore(options).load())?.refreshToken, "fake-refresh-newer");
  assert.equal(await exists(options.fallbackFilePath), false);
});

test("a session the server ended in file mode is not reported as a missing keyring", async () => {
  const { options } = await fallbackOptions(linuxStorage("basic_text"), {
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/oauth/userinfo") || pathname.endsWith("/oauth/token")) return new Response(null, { status: 401 });
      if (pathname.endsWith("/oauth/revoke")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${pathname}`);
    },
    sleep: async () => undefined,
  });
  await createDesktopMarsAccountStore(options).save(FAKE_CREDENTIALS);
  const status = await createDesktopMarsAccountStore(options).status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  assert.equal(status.keyringUnavailable, undefined);
});

test("client_update on /oauth/userinfo reaches the update gate and the account status", async () => {
  const heard = [];
  let clientUpdate = {
    required: true,
    product: "gui",
    current: "3.0.2",
    minimum: "3.1.0",
    deadline: "2026-10-04T17:12:00Z",
    blocked: false,
    message: "Update to 3.1.0",
    download_url: "https://marsai.click/download",
  };
  const options = await storeOptions({
    env: LEGACY_ENV,
    onClientUpdate: (value) => heard.push(value),
    fetchImpl: async () => Response.json({ email: "person@example.com", status: "active", ...(clientUpdate ? { client_update: clientUpdate } : {}) }),
  });
  const store = createDesktopMarsAccountStore(options);
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.deepEqual(status.clientUpdate, {
    required: true,
    blocked: false,
    current: "3.0.2",
    minimum: "3.1.0",
    deadline: "2026-10-04T17:12:00.000Z",
    message: "Update to 3.1.0",
    downloadUrl: "https://marsai.click/download",
  });
  assert.equal(heard.length, 1);
  assert.equal(heard[0].minimum, "3.1.0");
  // A profile without client_update is heard as null: the server lifted it.
  clientUpdate = null;
  assert.equal((await store.status()).clientUpdate, null);
  assert.deepEqual(heard.slice(1), [null]);
  // A listener that throws never breaks the account status.
  const throwing = createDesktopMarsAccountStore({ ...options, onClientUpdate: () => { throw new Error("listener"); } });
  assert.equal((await throwing.status()).connected, true);
});

test("every account request names the app: X-Mars-Client gui/<version>", async () => {
  const seen = [];
  const options = await storeOptions({
    clientVersion: "3.0.3",
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      seen.push({ pathname, client: new Headers(init.headers).get("x-mars-client") });
      if (pathname.endsWith("/oauth/device/code")) {
        return Response.json({ device_code: "d", user_code: "U", verification_uri_complete: "http://localhost:5175/c", interval: 0, expires_in: 60 });
      }
      if (pathname.endsWith("/oauth/token") || pathname.endsWith("/oauth/device/code")) {
        return Response.json({ access_token: `a${seen.length}`, refresh_token: `r${seen.length}`, api_base: "http://127.0.0.1:8000/v1" });
      }
      if (pathname.endsWith("/oauth/revoke")) return new Response(null, { status: 204 });
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  const store = createDesktopMarsAccountStore(options);
  await store.authorize({ gatewayUrl: "http://127.0.0.1:8000/v1", deviceName: "Test", openVerification: async () => undefined });
  assert.equal((await store.status()).connected, true);
  const current = await store.load();
  await store.refresh(current.accessToken);
  await store.clear();
  const paths = seen.map((entry) => entry.pathname);
  for (const path of ["/oauth/device/code", "/oauth/token", "/oauth/userinfo", "/oauth/revoke"]) {
    assert.ok(paths.includes(path), `${path} was requested`);
  }
  assert.ok(seen.every((entry) => entry.client === "gui/3.0.3"), JSON.stringify(seen));
});

test("no client version, no client header", async () => {
  let client = "unset";
  const options = await storeOptions({
    env: LEGACY_ENV,
    fetchImpl: async (_url, init = {}) => {
      client = new Headers(init.headers).get("x-mars-client");
      return Response.json({ email: "person@example.com", status: "active" });
    },
  });
  await createDesktopMarsAccountStore(options).status();
  assert.equal(client, null);
});

test("a diagnostic report goes to the crash endpoint with the device credential, and is null while signed out", async () => {
  const requests = [];
  const { store } = await connectedStore(async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body) });
    return Response.json({ accepted: true }, { status: 201 });
  });
  const response = await store.sendDiagnostic({ product: "gui", kind: "start_failure" });
  assert.equal(response.status, 201);
  assert.deepEqual(requests, [{
    url: "https://gateway.example/mars/diagnostics/crashes",
    method: "POST",
    authorization: "Bearer access-1",
    body: { product: "gui", kind: "start_failure" },
  }]);

  const signedOut = createDesktopMarsAccountStore(await storeOptions({
    fetchImpl: async () => {
      throw new Error("no request while signed out");
    },
  }));
  assert.equal(await signedOut.sendDiagnostic({ product: "gui" }), null);
});

test("an API key signs in by proving itself against the gateway's model list", async () => {
  const requests = [];
  const options = await storeOptions({
    fetchImpl: async (url, init = {}) => {
      requests.push({ pathname: new URL(url).pathname, authorization: new Headers(init.headers).get("authorization") });
      if (new URL(url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "marsai-auto" }] });
      }
      throw new Error(`Unexpected request ${new URL(url).pathname}`);
    },
  });
  const store = createDesktopMarsAccountStore(options);
  // Not even the shape of a MarsAI API key: refused before any request.
  await assert.rejects(store.authorizeApiKey({ apiKey: "not-a-mars-key" }), /it starts with sk-mars-/);
  assert.equal(await store.load(), null);

  const result = await store.authorizeApiKey({ apiKey: "sk-mars-abc123" });
  assert.deepEqual(result, { connected: true, kind: "api_key" });
  assert.deepEqual(await store.load(), {
    gatewayUrl: "https://marsai.click/v1",
    accessToken: "sk-mars-abc123",
    refreshToken: "",
    kind: "api_key",
    rotation: 0,
  });
  // The gateway verified the key against the model list it grants.
  assert.deepEqual(requests, [{ pathname: "/v1/models", authorization: "Bearer sk-mars-abc123" }]);

  // The status check verifies through the same grant, with no account identity.
  const status = await store.status();
  assert.equal(status.connected, true);
  assert.equal(status.credentialKind, "api_key");
  assert.equal(status.email, null);
  assert.equal(status.displayName, "MarsAI API key");
  assert.equal(requests.length, 2);
});

test("an API key the gateway rejects at sign-in never lands", async () => {
  const options = await storeOptions({
    env: { MARS_DEV_MODE: "1", MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1" },
    fetchImpl: async () => Response.json({ detail: "invalid_api_key" }, { status: 401 }),
  });
  const store = createDesktopMarsAccountStore(options);
  await assert.rejects(store.authorizeApiKey({ apiKey: "sk-mars-abc123" }), /rejected/);
  assert.equal(await store.load(), null);
  assert.equal(await exists(options.filePath), false);
});

test("an API key the gateway later refuses is not renewed; the user signs in again", async () => {
  const options = await storeOptions({
    env: { MARS_DEV_MODE: "1", MARS_GATEWAY_URL: "http://127.0.0.1:8000/v1" },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith("/models")) return Response.json({ detail: "invalid_api_key" }, { status: 401 });
      throw new Error(`Unexpected request ${new URL(url).pathname}`);
    },
  });
  const store = createDesktopMarsAccountStore(options);
  await store.save({ gatewayUrl: "http://127.0.0.1:8000/v1", accessToken: "sk-mars-abc123", refreshToken: "", kind: "api_key" });
  // The broker asked for a renewed pair on a 401: an API key has none to give.
  assert.equal(await store.refresh("sk-mars-abc123"), null);
  const status = await store.status();
  assert.equal(status.connected, false);
  assert.equal(status.reauthorizationRequired, true);
  // Nothing is left for a restart to resurrect.
  assert.equal((await createDesktopMarsAccountStore(options).status()).connected, false);
});

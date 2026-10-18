import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  discardPlaintextCredentialFile,
  logPlaintextCredentialsOnce,
  readPlaintextCredentialFile,
  removePlaintextCredentialFile,
  usableSafeStorage,
  writePlaintextCredentialFile,
} from "./plaintext-credential-file.mjs";
import { CLIENT_HEADER, guiClientHeaderValue, parseClientUpdate } from "./update-gate.mjs";
import { buildathonJoinError, buildathonLinkCode, buildathonLinkError, buildathonProjectName, buildathonTrackId, parseBuildathonAnswer, parseBuildathonSessions, parseBuildathonStatus } from "./buildathon.mjs";
import { parseAccountQuality, parseFailLabels, parseQualitySessions, parseSessionStatus, parseSpinHistory, profileSessionId, parseSpinResult, parseWheelSegments, spinIdempotencyKey, spinRefusal } from "./quality.mjs";

const execFileAsync = promisify(execFile);

/** @typedef {import("@mars/types/desktop-ipc").MarsAccountStatus} AccountStatus */
/** @typedef {import("@mars/types/desktop-ipc").MarsAccountUsage} AccountUsage */
/** @typedef {import("@mars/types/desktop-ipc").MarsAccountSignOutReason} SignOutReason */
/** @typedef {{ remoteRevoked: boolean, reason: SignOutReason }} SignOutOutcome */
/**
 * Runs the macOS `security` tool; injectable so tests never touch a keychain.
 * @typedef {(file: string, args: string[], options: { timeout: number, maxBuffer: number }) => Promise<{ stdout: string | Buffer, stderr: string | Buffer }>} SecurityCommandRunner
 */

export const KEYCHAIN_SERVICES = {
  gatewayUrl: "ai.marsai.desktop.gateway-url",
  accessToken: "ai.marsai.desktop.gateway-access",
  refreshToken: "ai.marsai.desktop.gateway-refresh",
};
const DEFAULT_GATEWAY_URL = "https://marsai.click/v1";
const DEV_GATEWAY_URL = "http://127.0.0.1:8000/v1";
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];
const SECURITY_TOOL = "/usr/bin/security";
/** The MarsAI OAuth client this desktop app signs in as (device flow). */
const MARS_OAUTH_CLIENT = "marscli";
/** Scopes the desktop app needs: inference, the model list and the account profile. */
const MARS_OAUTH_SCOPE = "mars:inference mars:models mars:account";
/** RFC 8628 device authorization grant identifier. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Upper bound on duplicate keychain items removed per service during sign-out. */
const MAX_KEYCHAIN_DELETES = 8;
/**
 * The account server still accepts the refresh token its latest rotation
 * replaced for this long. Any other superseded refresh token it receives
 * reads as a sign-in copied to a second device, so this store never sends one.
 */
const SERVER_ROTATION_GRACE_MS = 120_000;
const REFRESH_TIMEOUT_MS = 20_000;
/** A session's live status: past this the app shows its own checklist (the server contract's 3 s). */
const SESSION_STATUS_TIMEOUT_MS = 3_000;
/** Buildathon reads never hold anything up: past this the event is simply not shown. */
const BUILDATHON_TIMEOUT_MS = 10_000;
/**
 * A refresh token that may already have been rotated (the answer was lost)
 * is sent again only while that attempt, timeout included, ends inside the
 * server's grace, counted from the first time it was sent.
 */
const REFRESH_RETRY_WINDOW_MS = SERVER_ROTATION_GRACE_MS - REFRESH_TIMEOUT_MS;
const REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const PERSIST_RETRY_MAX_MS = 60_000;
/**
 * Connection failures that prove a request never reached the account server
 * (Node fetch and Electron net spellings), so nothing was rotated.
 */
const NEVER_SENT = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ERR_CERT_\w+|ERR_TLS_CERT_\w+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_\w+|CERT_HAS_EXPIRED)\b/;
const PLAINTEXT_KIND = "marsai.click sign-in";
const PLAINTEXT_NOTE = "Unencrypted at rest: no usable system keyring. Owner-only file; signing out deletes it.";

function sameCredentials(left, right) {
  return left.gatewayUrl === right.gatewayUrl
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.kind === right.kind;
}

function normalizeCredential(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A MarsAI API key as minted at marsai.click/app/keys (`sk-mars-…`). */
function isApiKeyToken(token) {
  return /^sk-mars-[A-Za-z0-9._-]+$/.test(token);
}

function normalizeGatewayUrl(value) {
  const normalized = normalizeCredential(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTNAMES.includes(url.hostname))) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Human-readable account server for a gateway URL: the host (with a
 * non-default port), marked "(local API)" for loopback development servers.
 * Examples: "marsai.click", "localhost:8090 (local API)".
 */
export function accountServerLabel(gatewayUrl) {
  const normalized = normalizeGatewayUrl(gatewayUrl);
  if (!normalized) return null;
  const url = new URL(normalized);
  return LOOPBACK_HOSTNAMES.includes(url.hostname) ? `${url.host} (local API)` : url.host;
}

/**
 * Classify the account server's answer to POST /oauth/revoke.
 *
 * - 2xx (the service answers 204): the device session was revoked now.
 * - 401/403: the credentials are already unknown, so the session is gone.
 * - 404 that names the session (any detail other than the framework's
 *   default "Not Found"): the session is gone as well.
 * - 404 with the framework default or no JSON body, 405, 410, 501: the
 *   server has no device sign-out route.
 * - Everything else (5xx, unexpected 4xx): the revocation did not happen.
 * @param {number} status
 * @param {string | null} [detail]
 * @returns {SignOutOutcome}
 */
export function classifyRemoteLogout(status, detail = null) {
  if (status >= 200 && status < 300) return { remoteRevoked: true, reason: "revoked" };
  if (status === 401 || status === 403) return { remoteRevoked: true, reason: "already_revoked" };
  if (status === 404) {
    const named = typeof detail === "string" && detail.trim() && !/^not found\.?$/i.test(detail.trim());
    return named
      ? { remoteRevoked: true, reason: "already_revoked" }
      : { remoteRevoked: false, reason: "endpoint_missing" };
  }
  if (status === 405 || status === 410 || status === 501) return { remoteRevoked: false, reason: "endpoint_missing" };
  return { remoteRevoked: false, reason: "unreachable" };
}

async function responseDetail(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    const payload = JSON.parse(text);
    if (typeof payload === "string") return normalizeCredential(payload);
    if (!payload || typeof payload !== "object") return null;
    return normalizeCredential(payload.detail) ?? normalizeCredential(payload.error) ?? normalizeCredential(payload.message);
  } catch {
    return null;
  }
}

/**
 * A credential bundle as persisted and handed to the embedded broker. The
 * `rotation` counter says how often this store refreshed the device session;
 * a bundle written before the counter existed loads as 0. `kind` says what
 * the access token is: an OAuth device session (`oauth`, access + refresh)
 * or a user-entered API key (`api_key`, nothing to renew). Bundles persisted
 * before the kind existed read as `oauth`.
 * @returns {{ gatewayUrl: string, accessToken: string, refreshToken: string, kind: "oauth" | "api_key", rotation: number } | null}
 */
function validCredentials(value) {
  if (!value || typeof value !== "object") return null;
  const gatewayUrl = normalizeGatewayUrl(value.gatewayUrl);
  const accessToken = normalizeCredential(value.accessToken);
  const refreshToken = normalizeCredential(value.refreshToken);
  if (!gatewayUrl || !accessToken) return null;
  const kind = value.kind === "api_key" || (!refreshToken && isApiKeyToken(accessToken)) ? "api_key" : "oauth";
  // An OAuth session is nothing without its refresh token; an API key has none.
  if (kind === "oauth" && !refreshToken) return null;
  const rotation = Number.isSafeInteger(value.rotation) && value.rotation >= 0 ? value.rotation : 0;
  return { gatewayUrl, accessToken, refreshToken: refreshToken ?? "", kind, rotation };
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** Names a failure for the log: its code, name or message, never a URL, header or body. */
function failureLabel(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string") return code;
  if (error?.name && error.name !== "Error" && error.name !== "TypeError") return String(error.name);
  return String(error?.message ?? error).slice(0, 160);
}

function neverSent(error) {
  const cause = error?.cause;
  const text = [error?.code, error?.message, cause?.code, cause?.message].filter((value) => typeof value === "string").join(" ");
  return NEVER_SENT.test(text);
}

/**
 * The control-plane URL for one endpoint: the gateway URL's host and any
 * extra path (minus /v1), then `endpoint` (which starts with "/"). Composing
 * the path textually — root could be "" and a URL cannot have an empty
 * pathname — stays correct even when the gateway sits on the host root.
 */
function controlPlaneEndpoint(gatewayUrl, endpoint) {
  const url = new URL(gatewayUrl);
  const root = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${root}${endpoint}`;
  return url;
}

function displayNameFromEmail(email) {
  const localPart = String(email).split("@", 1)[0] ?? "";
  const withoutCommonPrefix = localPart.replace(/^i[._-]?am(?=[a-z])/i, "");
  const words = withoutCommonPrefix
    .replace(/\d+$/, "")
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

/**
 * `GET /oauth/userinfo` balances, shaped as the app's `AccountUsage`: what is
 * used (`tokens_used`), what is left (`token_balance`) and the wallet's
 * one-time credit (`balance`). Null when the server sent no usage figures.
 * @returns {AccountUsage | null}
 */
function accountUsageFromUserinfo(value) {
  if (!value || typeof value !== "object") return null;
  const usedTokens = Number.isFinite(Number(value.tokens_used)) ? Number(value.tokens_used) : 0;
  const remainingTokens = Number.isFinite(Number(value.token_balance)) ? Number(value.token_balance) : 0;
  const pot = Math.max(0, Number.isFinite(Number(value.balance)) ? Number(value.balance) : 0);
  if (!usedTokens && !remainingTokens && !pot) return null;
  return {
    tokenLimit: 0,
    usedTokens,
    remainingTokens,
    period: "day",
    grantModel: null,
    limitScope: null,
    day: null,
    week: null,
    pot,
  };
}

/** A profile shaped from a `GET /oauth/userinfo` answer. */
function accountProfileFromUserinfo(value) {
  if (!value || typeof value !== "object") return null;
  const email = normalizeCredential(value.email);
  if (!email) return null;
  const usage = accountUsageFromUserinfo(value);
  return {
    email,
    displayName: normalizeCredential(value.name) ?? displayNameFromEmail(email),
    status: normalizeCredential(value.status),
    usage,
    clientUpdate: parseClientUpdate(value.client_update),
    // marsai.click carries no quality rewards; null keeps the feature off.
    quality: parseAccountQuality(value.quality),
  };
}

class InvalidAccountCredentialsError extends Error {}

async function readMacKeychain(service, platform, runSecurity) {
  if (platform !== "darwin") return null;
  try {
    const { stdout } = await runSecurity(["find-generic-password", "-s", service, "-w"]);
    return normalizeCredential(stdout);
  } catch {
    return null;
  }
}

/**
 * Remove every keychain item stored under `service`. Only macOS has these
 * legacy entries; other platforms have nothing to delete. `security` removes
 * one matching item per call and fails once none is left, which ends the loop.
 * Returns the number of items removed.
 */
async function deleteMacKeychain(service, platform, runSecurity) {
  if (platform !== "darwin") return 0;
  let removed = 0;
  while (removed < MAX_KEYCHAIN_DELETES) {
    try {
      await runSecurity(["delete-generic-password", "-s", service]);
      removed += 1;
    } catch {
      break;
    }
  }
  return removed;
}

/**
 * Whether this launch may read, and on sign-out remove, the legacy macOS
 * keychain entries (KEYCHAIN_SERVICES). They hold the owner's real
 * account, and belong to the default production profile alone: a dev,
 * eval, test or blank-slate profile, a custom MARS_ELECTRON_USERDATA or
 * MARS_ELECTRON_APP_IDENTIFIER, or the mock keychain must never import
 * them.
 * @param {{ appIdentifier: string, productionAppIdentifier: string, blankSlate: boolean, env?: NodeJS.ProcessEnv }} launch
 */
export function legacyKeychainAllowed({ appIdentifier, productionAppIdentifier, blankSlate, env = process.env }) {
  return appIdentifier === productionAppIdentifier
    && !blankSlate
    && !env.MARS_ELECTRON_USERDATA?.trim()
    && !env.MARS_ELECTRON_APP_IDENTIFIER?.trim()
    && env.MARS_ELECTRON_USE_MOCK_KEYCHAIN !== "1";
}

export function createDesktopMarsAccountStore({
  filePath,
  loadSafeStorage,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  execFileImpl = /** @type {SecurityCommandRunner} */ (execFileAsync),
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  // Only the default production profile may use the legacy keychain entries (legacyKeychainAllowed).
  legacyKeychain = false,
  // Where the sign-in is kept, unencrypted at rest with owner-only
  // permissions, while no keyring is usable: Linux without a keyring, or any
  // platform whose keyring refuses to encrypt (a macOS keychain entry the
  // updated app may no longer open). See plaintext-credential-file.mjs.
  fallbackFilePath = null,
  // Linux only: told which safeStorage backend sealed the sign-in once it is
  // written and read back, so later launches keep that --password-store.
  onKeyringSealed = null,
  log = (message) => console.warn(message),
  now = () => Date.now(),
  // First pause before a failed save of a rotated pair is tried again; tests shrink it.
  persistRetryBaseMs = 1_000,
  // Hears `client_update` from the account answers (update-gate.mjs); null
  // when an answer carried none.
  onClientUpdate = null,
  // The desktop app's version, named on every account request as
  // `X-Mars-Client: gui/<version>`; unset sends no header.
  clientVersion = null,
}) {
  // An explicit MARS_GATEWAY_URL, read once here: the runtime deletes it
  // from process.env when it starts the embedded server (runtime.mjs), and a
  // later sign-in must still go to the server it named, not to marsai.click.
  const explicitGatewayUrl = normalizeGatewayUrl(env.MARS_GATEWAY_URL);
  const clientHeader = guiClientHeaderValue(clientVersion);
  /** fetchImpl with `X-Mars-Client` added to every account request. */
  const send = clientHeader
    ? (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set(CLIENT_HEADER, clientHeader);
      return fetchImpl(url, { ...init, headers });
    }
    : fetchImpl;
  /** A `client_update` this account server sent; never lets the gate break sign-in. */
  function reportClientUpdate(payload) {
    if (typeof onClientUpdate !== "function" || !payload || typeof payload !== "object") return;
    try {
      onClientUpdate(parseClientUpdate(payload.client_update));
    } catch {
      // The gate is advisory here; the account flow goes on.
    }
  }

  // This store is the one owner of the device session's refresh token: its
  // own profile check and the embedded broker (runtime.mjs wires the
  // broker's `refresh` to refresh() below) both come here, and only here is
  // a refresh token sent. Both run in the Electron main process.
  /** The current pair: the owner's truth, ahead of the disk while a save of it keeps failing. */
  let cached = null;
  /** The pair a restart would load (the saved file, or the environment/keychain import). */
  let persisted = null;
  /**
   * The current pair's refresh token was sent at `firstSentAt` and no answer
   * settled it: the rotation may have happened with the answer lost.
   * @type {{ hash: string, firstSentAt: number } | null}
   */
  let inFlight = null;
  /** The store dropped a pair it may not present any more; the user signs in again. */
  let signInRequired = false;
  let persistRetry = null;
  let persistRetryAttempt = 0;
  let loading = null;
  const fileFallback = Boolean(fallbackFilePath);
  /**
   * The keyring refused to encrypt in this process. Electron keeps its
   * encryptor for the life of the process, so asking again only fails again
   * (and on macOS may show the keychain prompt again): the private file is
   * used until the next launch.
   */
  let keyringRefused = false;
  let keyringLossLogged = false;
  /** A keyring copy is on disk but this launch's keyring cannot decrypt it. */
  let sealedUnreadable = false;
  let sealedBackendRecorded = null;
  // Every writer is tracked so a reader, the broker's latest() in
  // particular, observes a settled store rather than the pair a rotation is
  // about to replace.
  let refreshInFlight = null;
  let saveInFlight = null;
  let clearInFlight = null;
  /** Whether the sign-out in flight revokes the session (see save()). */
  let clearRevokesRemote = false;
  const signedOutPath = `${filePath}.signed-out`;
  /**
   * Written before a refresh token is sent and removed once the rotated pair
   * is saved: after a crash or quit mid-refresh, the next launch knows the
   * token on disk may have been rotated already. It holds a hash of the
   * token, never the token.
   */
  const refreshingPath = `${filePath}.refreshing`;
  const runSecurity = (args) => (legacyKeychain
    ? execFileImpl(SECURITY_TOOL, args, { timeout: 5_000, maxBuffer: 64 * 1024 })
    : Promise.reject(new Error("The legacy keychain entries belong to the default production profile")));

  /**
   * Resolves once every in-flight refresh, save and sign-out has finished.
   * A refresh ends in a save and a save may queue behind another, so this
   * re-checks a bounded number of times instead of trusting one snapshot.
   * @param {{ includeRefresh?: boolean, includeClear?: boolean }} [options]
   * `refresh()` and `clear()` must not wait for their own promise; a refresh
   * also never waits for a sign-out (which waits for the refresh).
   */
  async function settle({ includeRefresh = true, includeClear = true } = {}) {
    for (let round = 0; round < 8; round += 1) {
      const pending = [includeRefresh ? refreshInFlight : null, saveInFlight, includeClear ? clearInFlight : null].filter(Boolean);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  async function safeStorage() {
    if (keyringRefused) return null;
    return usableSafeStorage(loadSafeStorage, platform);
  }

  /** Writes the private file and warns once. */
  async function writeFallbackFile(normalized) {
    await writePlaintextCredentialFile(
      fallbackFilePath,
      `${JSON.stringify({ note: PLAINTEXT_NOTE, credentials: normalized }, null, 2)}\n`,
    );
    logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
  }

  async function loadFallbackFile() {
    try {
      const contents = await readPlaintextCredentialFile(fallbackFilePath);
      return contents ? validCredentials(JSON.parse(contents)?.credentials) : null;
    } catch {
      return null;
    }
  }

  function noteSealedUnreadable() {
    if (!sealedUnreadable) log("[mars] The saved marsai.click sign-in cannot be decrypted by the system keyring now; asking to sign in again.");
    sealedUnreadable = true;
  }

  /** Tell main which backend sealed the sign-in (once per backend per process). */
  async function noteKeyringSealed(storage) {
    if (platform !== "linux" || !fileFallback || !onKeyringSealed) return;
    const backend = storage.getSelectedStorageBackend();
    if (sealedBackendRecorded === backend) return;
    try {
      await onKeyringSealed(backend);
      sealedBackendRecorded = backend;
    } catch {
      // Best effort: without the record the startup probe still decides.
    }
  }

  async function modifiedAt(file) {
    try {
      return (await stat(file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async function decryptKeyringCopy(storage) {
    try {
      const decrypted = await storage.decryptStringAsync(await readFile(filePath));
      const credentials = validCredentials(JSON.parse(decrypted.result));
      return credentials ? { credentials, shouldReEncrypt: Boolean(decrypted.shouldReEncrypt) } : null;
    } catch {
      return null;
    }
  }

  async function loadFile() {
    try {
      const storage = await safeStorage();
      if (!storage) {
        if (!fileFallback) return null;
        const credentials = await loadFallbackFile();
        if (credentials) logPlaintextCredentialsOnce(PLAINTEXT_KIND, log);
        return credentials;
      }
      const sealed = await decryptKeyringCopy(storage);
      const unprotected = fileFallback ? await loadFallbackFile() : null;
      // The private file is written only while no keyring is usable, so it is
      // normally the newest copy; a readable keyring copy written after it
      // wins (the file is then a leftover whose delete failed).
      if (unprotected && !(sealed && await modifiedAt(filePath) > await modifiedAt(fallbackFilePath))) {
        // A keyring is usable now: move the sign-in out of the private file.
        // writeCredentials deletes the file only once the encrypted copy has
        // been written and read back; otherwise the file stays and keeps the
        // user signed in, and a later load retries.
        await enqueueWrite(unprotected).then(
          () => {
            if (!keyringRefused) log("[mars] Moved the marsai.click sign-in from the private file into the system keyring.");
          },
          () => undefined,
        );
        return unprotected;
      }
      if (!sealed) {
        // A saved sign-in this keyring cannot open (an update changed the
        // app's identity, the keychain entry was denied or replaced): signed
        // out, and the user is asked to sign in again.
        if (await exists(filePath)) noteSealedUnreadable();
        return null;
      }
      if (unprotected) await discardPlaintextCredentialFile(fallbackFilePath, PLAINTEXT_KIND, log);
      await noteKeyringSealed(storage);
      if (sealed.shouldReEncrypt) await enqueueWrite(sealed.credentials);
      return sealed.credentials;
    } catch {
      return null;
    }
  }

  /**
   * The stored credentials once the store is settled. This is also the
   * broker's `latest()`: it must never answer with a pair that an in-flight
   * refresh, save or sign-out is about to replace.
   */
  async function load() {
    await settle();
    return readCredentials();
  }

  async function readCredentials() {
    if (cached) return cached;
    loading ??= loadCredentials().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function exists(file) {
    return access(file).then(() => true, () => false);
  }

  async function loadCredentials() {
    const stored = await loadFile();
    const imported = stored ? null : await legacyCredentials();
    const credentials = stored ?? imported;
    if (!credentials) return null;
    if (!(await usableAfterRestart(credentials))) {
      return forget("The saved marsai.click sign-in was being renewed when the app stopped, longer ago than the account server accepts that token again.");
    }
    cached = credentials;
    persisted = credentials;
    // A refresh the last exit cut off is finished now, while the server still
    // accepts its token (its access token may keep working a little longer).
    if (inFlight) void refresh(credentials.accessToken).catch(() => undefined);
    if (imported) {
      await enqueueWrite(imported);
      // Imported once: an old keychain copy must never come back later.
      if (!env.MARS_REFRESH_TOKEN) {
        await deleteMacKeychain(KEYCHAIN_SERVICES.accessToken, platform, runSecurity);
        await deleteMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform, runSecurity);
      }
    }
    return credentials;
  }

  /**
   * Environment or legacy keychain credentials, imported only while no
   * sign-in is on disk at all: never over a saved sign-in this launch cannot
   * read (a locked or replaced keyring), whose pair is newer, and never after
   * a sign-out.
   */
  async function legacyCredentials() {
    if (await exists(filePath) || (fileFallback && await exists(fallbackFilePath))) return null;
    if (await exists(signedOutPath)) return null;
    return validCredentials({
      gatewayUrl: env.MARS_GATEWAY_URL ?? await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity),
      accessToken: env.MARS_ACCESS_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.accessToken, platform, runSecurity),
      refreshToken: env.MARS_REFRESH_TOKEN ?? await readMacKeychain(KEYCHAIN_SERVICES.refreshToken, platform, runSecurity),
    });
  }

  /** @returns {Promise<{ hash: string, rotation: number, firstSentAt: number } | null>} */
  async function readRefreshing() {
    try {
      const value = JSON.parse(await readFile(refreshingPath, "utf8"));
      const valid = typeof value?.refreshTokenSha256 === "string"
        && Number.isSafeInteger(value.rotation) && value.rotation >= 0
        && Number.isSafeInteger(value.firstSentAt) && value.firstSentAt >= 0;
      return valid ? { hash: value.refreshTokenSha256, rotation: value.rotation, firstSentAt: value.firstSentAt } : null;
    } catch {
      return null;
    }
  }

  /** Atomic (temporary file, then rename). `firstSentAt: 0` marks a token never to be sent again. */
  async function writeRefreshing({ hash, rotation, firstSentAt }) {
    await mkdir(path.dirname(refreshingPath), { recursive: true });
    const temporary = `${refreshingPath}.${process.pid}.tmp`;
    const record = { note: "A device sign-in renewal was in flight. Hash only; no token.", refreshTokenSha256: hash, rotation, firstSentAt };
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, refreshingPath).catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
  }

  function withinRetryWindow(firstSentAt, delay = 0) {
    return firstSentAt > 0 && now() + delay - firstSentAt <= REFRESH_RETRY_WINDOW_MS;
  }

  /**
   * Whether a pair read at launch may be used. A refresh of it that was in
   * flight when the app stopped (crash, quit, update) may have rotated it
   * with the answer lost: it is sent again only inside the server's grace,
   * and a pair behind a rotation that was recorded is never used.
   */
  async function usableAfterRestart(credentials) {
    const record = await readRefreshing();
    if (!record) return true;
    const hash = tokenHash(credentials.refreshToken);
    if (record.hash === hash) {
      if (!withinRetryWindow(record.firstSentAt)) return false;
      inFlight = { hash, firstSentAt: record.firstSentAt };
      return true;
    }
    if (record.rotation > credentials.rotation) return false;
    // Left behind by a pair that has since been saved.
    await rm(refreshingPath, { force: true });
    return true;
  }

  /**
   * Ends the local sign-in without sending its refresh token anywhere, not
   * even to /oauth/revoke: it may be superseded, and a superseded token the
   * server receives reads as a copied sign-in. The user signs in again.
   */
  async function forget(reason) {
    log(`[mars] ${reason} Asking to sign in again.`);
    await serialize(removeLocalSignIn);
    signInRequired = true;
    return null;
  }

  async function removeLocalSignIn() {
    cached = null;
    persisted = null;
    inFlight = null;
    stopPersistRetry();
    // Sentinel first: a reader that slips in between never sees the file
    // without the sentinel and resurrects the account from disk.
    await mkdir(path.dirname(signedOutPath), { recursive: true });
    await writeFile(signedOutPath, "signed-out\n", { mode: 0o600 });
    await rm(filePath, { force: true });
    if (fileFallback) await removePlaintextCredentialFile(fallbackFilePath);
    await rm(refreshingPath, { force: true });
  }

  /**
   * Persist a bundle (a sign-in; this store's own rotations save themselves).
   * A bundle rotated fewer times than the current pair is older and is never
   * written over it. A save that arrives while the user is signing out is
   * dropped, that session is being revoked; one that arrives during a
   * server-driven sign-out lands afterwards.
   */
  async function save(credentials) {
    const normalized = validCredentials(credentials);
    if (!normalized) throw new Error("Invalid Mars account credential bundle");
    if (clearInFlight) {
      const revoked = clearRevokesRemote;
      await clearInFlight;
      if (revoked) return;
    }
    const current = cached ?? await loadFile();
    if (current && normalized.rotation < current.rotation) {
      log(`[mars] Kept the current marsai.click sign-in (rotation ${current.rotation}); an older one (rotation ${normalized.rotation}) was not saved over it.`);
      return;
    }
    await enqueueWrite(normalized);
  }

  /**
   * Serialized disk writer: sign-ins, rotations and the refresh record share
   * one queue (and temporary files). Internal writes (legacy import,
   * re-encryption) use it directly since they can run inside a sign-out.
   */
  function serialize(task) {
    const previous = saveInFlight;
    const write = (async () => {
      if (previous) await previous.catch(() => undefined);
      return task();
    })();
    saveInFlight = write;
    return write.finally(() => {
      if (saveInFlight === write) saveInFlight = null;
    });
  }

  function enqueueWrite(normalized) {
    return serialize(() => writeCredentials(normalized));
  }

  async function writeCredentials(normalized) {
    const storage = await safeStorage();
    /** @type {Buffer | null} */
    let encrypted = null;
    if (storage) {
      try {
        encrypted = await storage.encryptStringAsync(JSON.stringify(normalized));
      } catch (error) {
        // isAsyncEncryptionAvailable() only says the encryptor started, not
        // that the keyring gave it a key: a denied or locked macOS keychain
        // (the app's code signature changed with an update), a Windows DPAPI
        // failure. Never fail the sign-in over it.
        if (!fileFallback) throw new Error(`Secure desktop credential storage is unavailable: ${error?.message ?? error}`);
        keyringRefused = true;
        log(`[mars] The system keyring could not encrypt the marsai.click sign-in (${error?.message ?? error}); keeping it in the private file.`);
      }
    }
    if (!encrypted) {
      if (!fileFallback) throw new Error("Secure desktop credential storage is unavailable");
      // Unencrypted at rest, protected only by owner-only permissions: no
      // usable keyring. The next load with a working keyring migrates it.
      await writeFallbackFile(normalized);
      // A keyring copy left on disk holds an older pair this one replaces:
      // never let a later launch read it back.
      if (storage) await rm(filePath, { force: true }).catch(() => undefined);
    } else {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await rename(temporary, filePath).catch(async (error) => {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      });
      if (fileFallback) {
        // Only trust the keyring copy once it reads back. Until then the
        // private file keeps the sign-in (a keyring that encrypts but cannot
        // decrypt, a locked or half-started Secret Service).
        const readBack = await decryptKeyringCopy(storage);
        if (readBack && sameCredentials(readBack.credentials, normalized)) {
          await discardPlaintextCredentialFile(fallbackFilePath, PLAINTEXT_KIND, log);
          await noteKeyringSealed(storage);
        } else {
          log("[mars] The system keyring did not return the saved marsai.click sign-in; keeping it in the private file.");
          await writeFallbackFile(normalized);
        }
      }
    }
    await rm(signedOutPath, { force: true });
    cached = normalized;
    persisted = normalized;
    signInRequired = false;
  }

  async function configuredGatewayUrl() {
    // Development builds keep using marsai.click. Only an explicit
    // MARS_GATEWAY_URL, or MARS_DEV_MODE=1 together with
    // MARS_LOCAL_API=1, points the account service at a local API.
    const localApiSelected = env.MARS_DEV_MODE === "1" && env.MARS_LOCAL_API === "1";
    return explicitGatewayUrl
      ?? normalizeGatewayUrl(await readMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity))
      ?? (localApiSelected ? DEV_GATEWAY_URL : DEFAULT_GATEWAY_URL);
  }

  /**
   * The only place a refresh token is sent. The embedded broker and this
   * store's profile check both come here after a 401, with the access token
   * that was refused. One refresh runs at a time; a caller that arrives
   * during one waits for it, then decides against the pair it left, so a
   * refresh token is never spent twice.
   *
   * Resolves the current pair: the one already past `rejectedAccessToken`
   * (no request), or a new rotation, saved before it is handed out. Resolves
   * null once the session is gone and the user has to sign in again. Rejects
   * when no rotation happened right now (offline, refused); the pair is kept.
   * @param {string} rejectedAccessToken
   */
  async function refresh(rejectedAccessToken) {
    while (refreshInFlight) await refreshInFlight.catch(() => undefined);
    refreshInFlight = (async () => {
      await settle({ includeRefresh: false, includeClear: false });
      const current = await readCredentials();
      if (!current || current.accessToken !== rejectedAccessToken) return current;
      // An API key has nothing to renew: the account server rejected it, so
      // the session is over and the user signs in or enters a new key again.
      if (current.kind === "api_key") return forget("The MarsAI API key was rejected by the account server.");
      return rotate(current);
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  /**
   * Sends the current pair's refresh token until an answer settles it. After
   * an answer that was lost the same token is sent again, only while inside
   * the server's grace; past it the token is never sent again.
   */
  async function rotate(current) {
    const started = await beginRefresh(current);
    if (!started) {
      return forget("Renewing the marsai.click sign-in got no answer, longer ago than the account server accepts that token again.");
    }
    // Whether an earlier attempt may have rotated the token with its answer lost.
    let unsettled = !started.fresh;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await sendRefresh(current);
      if (outcome.kind === "rotated") {
        inFlight = null;
        cached = outcome.credentials;
        await persistCurrent();
        return outcome.credentials;
      }
      if (outcome.kind === "retired") {
        return forget("The account server no longer accepts this device's marsai.click sign-in.");
      }
      if (outcome.kind === "unchanged" && !unsettled) {
        await endRefresh(current);
        throw new Error(`Account refresh unavailable (${outcome.detail})`);
      }
      // Lost, or refused after an earlier attempt that may have rotated the
      // token: only another attempt inside the grace can settle it.
      unsettled = true;
      const delay = REFRESH_RETRY_DELAYS_MS[Math.min(attempt, REFRESH_RETRY_DELAYS_MS.length - 1)];
      if (!withinRetryWindow(started.firstSentAt, delay)) {
        return forget(`Renewing the marsai.click sign-in got no usable answer (${outcome.detail}) before the account server's grace for sending it again ran out.`);
      }
      log(`[mars] Renewing the marsai.click sign-in got no usable answer (${outcome.detail}); sending the same token again inside the server's grace.`);
      await sleep(delay);
      // A sign-out is waiting for this refresh; it revokes the pair as it is.
      if (clearInFlight) throw new Error("Account refresh stopped for a sign-out");
    }
  }

  /**
   * Records, on disk before it is sent, that `current`'s refresh token is in
   * flight. Resolves null when it may not be sent any more; `fresh` is false
   * when it is being sent again after an attempt that settled nothing.
   * @returns {Promise<{ fresh: boolean, firstSentAt: number } | null>}
   */
  async function beginRefresh(current) {
    const hash = tokenHash(current.refreshToken);
    if (inFlight?.hash === hash) {
      return withinRetryWindow(inFlight.firstSentAt) ? { fresh: false, firstSentAt: inFlight.firstSentAt } : null;
    }
    const firstSentAt = now();
    try {
      await serialize(() => writeRefreshing(persisted.refreshToken === current.refreshToken
        ? { hash, rotation: current.rotation, firstSentAt }
        // The pair a restart would load is already behind this one (its save
        // keeps failing); after this rotation it is two behind and must never
        // be sent again.
        : { hash: tokenHash(persisted.refreshToken), rotation: persisted.rotation, firstSentAt: 0 }));
    } catch (error) {
      log(`[mars] Could not record the marsai.click sign-in renewal before sending it (${failureLabel(error)}); not renewing now.`);
      throw error;
    }
    inFlight = { hash, firstSentAt };
    return { fresh: true, firstSentAt };
  }

  /** The token was answered without a rotation, or never reached the server: it stays current. */
  async function endRefresh(current) {
    inFlight = null;
    // Otherwise the record guards an older pair on disk and stays.
    if (persisted?.refreshToken === current.refreshToken) await serialize(() => rm(refreshingPath, { force: true }));
  }

  /**
   * One POST /oauth/token (refresh_token grant, form-encoded). `rotated`
   * carries the new pair; `retired`: the server does not know the token
   * (401/403, or the RFC 6749 `invalid_grant` answer for a revoked or
   * exhausted token family); `unchanged`: answered without a rotation, or
   * never reached the server; `unknown`: the rotation may have happened
   * with its answer lost (timeout, reset, 408, 409, 5xx other than 503, an
   * unreadable success).
   */
  async function sendRefresh(credentials) {
    const refreshUrl = controlPlaneEndpoint(credentials.gatewayUrl, "/oauth/token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: MARS_OAUTH_CLIENT,
    });
    let response;
    try {
      response = await send(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: neverSent(error) ? "unchanged" : "unknown", detail: failureLabel(error) };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "retired" };
    }
    if (!response.ok) {
      const oauthError = await responseDetail(response);
      if (oauthError === "invalid_grant") return { kind: "retired" };
      const lost = (response.status >= 500 && response.status !== 503) || response.status === 408 || response.status === 409;
      return { kind: lost ? "unknown" : "unchanged", detail: oauthError ? `HTTP ${response.status} (${oauthError})` : `HTTP ${response.status}` };
    }
    try {
      const payload = await response.json();
      if (payload && typeof payload === "object" && "client_update" in payload) reportClientUpdate(payload);
      const rotated = validCredentials({
        gatewayUrl: normalizeGatewayUrl(payload.api_base) ?? credentials.gatewayUrl,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        rotation: credentials.rotation + 1,
      });
      if (rotated) return { kind: "rotated", credentials: rotated };
    } catch {
      // An answer cut off or unreadable counts as lost.
    }
    return { kind: "unknown", detail: "unreadable answer" };
  }

  /**
   * Saves the pair this store just rotated to. Until a save lands the pair
   * stays the in-memory truth (never swapped back for the pair on disk, which
   * it superseded), the refresh record keeps that older pair from being sent
   * after a restart, and the save is retried.
   */
  async function persistCurrent() {
    const pair = cached;
    if (!pair || persisted === pair) return;
    try {
      await serialize(async () => {
        if (cached !== pair) return;
        // Sent already without an answer: its record moves to this pair before the pair lands on disk.
        const unsettled = inFlight?.hash === tokenHash(pair.refreshToken) ? inFlight : null;
        if (unsettled) await writeRefreshing({ hash: unsettled.hash, rotation: pair.rotation, firstSentAt: unsettled.firstSentAt });
        await writeCredentials(pair);
        if (!unsettled) await rm(refreshingPath, { force: true });
      });
      stopPersistRetry();
    } catch (error) {
      persistRetryAttempt += 1;
      log(`[mars] Could not save the renewed marsai.click sign-in (${failureLabel(error)}, attempt ${persistRetryAttempt}); keeping it in memory and trying again.`);
      schedulePersistRetry();
    }
  }

  function schedulePersistRetry() {
    if (persistRetry) return;
    const delay = Math.min(PERSIST_RETRY_MAX_MS, persistRetryBaseMs * 2 ** Math.min(persistRetryAttempt - 1, 10));
    persistRetry = setTimeout(() => {
      persistRetry = null;
      // A refresh in flight saves its own result; a sign-out drops the pair.
      if (refreshInFlight || clearInFlight) schedulePersistRetry();
      else void persistCurrent();
    }, delay);
    persistRetry.unref?.();
  }

  function stopPersistRetry() {
    if (persistRetry) clearTimeout(persistRetry);
    persistRetry = null;
    persistRetryAttempt = 0;
  }

  /**
   * Revoke the MarsAI session on the account server (POST /oauth/revoke,
   * RFC 7009; the refresh token, or the API key itself when signing out of
   * one). Never throws: the caller clears local credentials either way and
   * reports the outcome.
   * @returns {Promise<SignOutOutcome>}
   */
  async function remoteLogout(credentials) {
    const logoutUrl = controlPlaneEndpoint(credentials.gatewayUrl, "/oauth/revoke");
    const body = new URLSearchParams({
      token: credentials.refreshToken || credentials.accessToken,
      client_id: MARS_OAUTH_CLIENT,
    });
    let response;
    try {
      response = await send(logoutUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { remoteRevoked: false, reason: "unreachable" };
    }
    const detail = response.status === 404 ? await responseDetail(response) : null;
    return classifyRemoteLogout(response.status, detail);
  }

  /**
   * The account profile. An OAuth session reads `GET /oauth/userinfo` with
   * refresh-on-401; an API key asks the gateway for its model list (which
   * is what the key grants) and carries no account identity.
   * @param {number} refreshesLeft Bounded: one refresh may only hand back a
   * pair rotated earlier (for the broker), whose access token can itself have
   * expired while the app was idle, so a second one is allowed before the
   * session counts as gone.
   */
  async function fetchProfile(credentials, refreshesLeft = 2, sessionId = null) {
    if (credentials.kind === "api_key") return fetchApiKeyProfile(credentials);
    const profileUrl = controlPlaneEndpoint(credentials.gatewayUrl, "/oauth/userinfo");
    const response = await send(profileUrl, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 && refreshesLeft > 0) {
      const refreshed = await refresh(credentials.accessToken);
      if (!refreshed) throw new InvalidAccountCredentialsError("MarsAI session expired");
      return fetchProfile(refreshed, refreshesLeft - 1, sessionId);
    }
    if (response.status === 401 || response.status === 403) {
      throw new InvalidAccountCredentialsError("MarsAI session expired");
    }
    if (!response.ok) return null;
    const payload = await response.json();
    // The userinfo answer is authoritative: no client_update there clears the gate.
    reportClientUpdate(payload && typeof payload === "object" ? payload : {});
    return accountProfileFromUserinfo(payload);
  }

  /**
   * A keyed sign-in is confirmed by what it can actually do: the gateway
   * accepts it for the model list. 401/403: the key is invalid or revoked.
   * Null while unreachable or on any other bad answer (still connected).
   */
  async function fetchApiKeyProfile(credentials) {
    const modelsUrl = new URL(credentials.gatewayUrl);
    modelsUrl.pathname += "/models";
    const response = await send(modelsUrl, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new InvalidAccountCredentialsError("MarsAI API key invalid");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    await response.body?.cancel().catch(() => undefined);
    return {
      email: null,
      displayName: "MarsAI API key",
      status: null,
      usage: null,
      clientUpdate: null,
      quality: null,
    };
  }

  /**
   * Sign in with a MarsAI account: the OAuth 2.0 device flow against
   * marsai.click. Asks the account server for a device code, opens the
   * verification page, then polls POST /oauth/token until the user approves
   * (authorization_pending / slow_down keep polling), denies
   * (access_denied) or the link expires (expired_token, or the deadline).
   * @param {{ gatewayUrl?: string, deviceName?: string, openVerification: (url: string) => unknown }} input
   * `deviceName` is accepted for the IPC shape; the device request carries
   * only the client id and scope.
   * @returns {Promise<{ connected: true, userCode: string, kind: "oauth" }>}
   */
  async function authorize({ gatewayUrl, openVerification }) {
    const explicitGateway = normalizeCredential(gatewayUrl);
    const configured = explicitGateway ? normalizeGatewayUrl(explicitGateway) : await configuredGatewayUrl();
    if (!configured) throw new Error("Mars account service is not configured");
    // RFC 8628 §3.1: request the device code (form-encoded, no client secret).
    const deviceUrl = controlPlaneEndpoint(configured, "/oauth/device/code");
    const deviceBody = new URLSearchParams({ client_id: MARS_OAUTH_CLIENT, scope: MARS_OAUTH_SCOPE });
    const issuedResponse = await send(deviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: deviceBody.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!issuedResponse.ok) {
      await issuedResponse.body?.cancel().catch(() => undefined);
      throw new Error(`Could not start account link (HTTP ${issuedResponse.status})`);
    }
    const issued = await issuedResponse.json();
    const verificationUrl = normalizeCredential(issued?.verification_uri_complete)
      ?? normalizeCredential(issued?.verification_uri);
    if (!issued?.device_code || !issued?.user_code || !verificationUrl) {
      throw new Error("Account service returned an invalid device link");
    }
    await openVerification(verificationUrl);

    // RFC 8628 §3.4: poll POST /oauth/token with the device grant.
    const tokenUrl = controlPlaneEndpoint(configured, "/oauth/token");
    const deviceTokenBody = new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: String(issued.device_code),
      client_id: MARS_OAUTH_CLIENT,
    });
    let interval = Math.max(2, Number(issued.interval) || 5) * 1_000;
    const deadline = now() + Math.max(60, Number(issued.expires_in) || 900) * 1_000;
    while (now() < deadline) {
      await sleep(interval);
      let tokenResponse;
      try {
        tokenResponse = await send(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: deviceTokenBody.toString(),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        // A poll that never reached the account server (offline for a moment)
        // keeps the link open; anything else ends it with the failure.
        if (!neverSent(error)) throw new Error(`Account link failed (${failureLabel(error)})`);
        continue;
      }
      if (!tokenResponse.ok) {
        const oauthError = await responseDetail(tokenResponse);
        if (oauthError === "authorization_pending") continue;
        if (oauthError === "slow_down") {
          // RFC 8628 §3.5: back off by 5 s per slow_down.
          interval += 5_000;
          continue;
        }
        if (oauthError === "access_denied") throw new Error("Account link was denied in the browser");
        if (oauthError === "expired_token") throw new Error("Account link expired before it was approved");
        throw new Error(`Account link failed (${oauthError ? `HTTP ${tokenResponse.status}: ${oauthError}` : `HTTP ${tokenResponse.status}`})`);
      }
      const payload = await tokenResponse.json();
      if (payload && typeof payload === "object" && "client_update" in payload) reportClientUpdate(payload);
      const credentials = validCredentials({
        gatewayUrl: normalizeGatewayUrl(payload.api_base) ?? configured,
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
      });
      if (!credentials) throw new Error("Account service returned invalid credentials");
      // A brand-new session always lands, even next to a sign-out of the old one.
      await serialize(async () => {
        await writeCredentials(credentials);
        // The refresh record belonged to the session this one replaces.
        inFlight = null;
        stopPersistRetry();
        await rm(refreshingPath, { force: true }).catch(() => undefined);
      });
      return /** @type {const} */ ({ connected: true, userCode: String(issued.user_code), kind: "oauth" });
    }
    throw new Error("Account link expired before it was approved");
  }

  /**
   * Sign in with a MarsAI API key (entered by hand; minted at
   * marsai.click/app/keys). The key is checked against the gateway's model
   * list — what the key grants — and then stored like any sign-in, but with
   * nothing to renew: a key that is later revoked ends the session, it does
   * not refresh.
   * @param {{ apiKey?: unknown, gatewayUrl?: string }} [input]
   * @returns {Promise<{ connected: true, kind: "api_key" }>}
   */
  async function authorizeApiKey(input = {}) {
    const explicitGateway = normalizeCredential(input?.gatewayUrl);
    const configured = explicitGateway ? normalizeGatewayUrl(explicitGateway) : await configuredGatewayUrl();
    if (!configured) throw new Error("Mars account service is not configured");
    const key = normalizeCredential(input?.apiKey);
    if (!key || !isApiKeyToken(key)) throw new Error("Enter a MarsAI API key (it starts with sk-mars-)");
    // The gateway refuses the key for its model list unless it is valid.
    const modelsUrl = new URL(configured);
    modelsUrl.pathname += "/models";
    const response = await send(modelsUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("The MarsAI API key was rejected (it is invalid or was revoked)");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Could not verify the MarsAI API key (HTTP ${response.status}). Try again in a moment`);
    }
    await response.body?.cancel().catch(() => undefined);
    const credentials = validCredentials({ gatewayUrl: configured, accessToken: key, refreshToken: "", kind: "api_key" });
    if (!credentials) throw new Error("Invalid MarsAI API key");
    // A brand-new sign-in always lands, even next to a sign-out in progress.
    await serialize(async () => {
      await writeCredentials(credentials);
      inFlight = null;
      stopPersistRetry();
      await rm(refreshingPath, { force: true }).catch(() => undefined);
    });
    return { connected: true, kind: "api_key" };
  }

  /**
   * Whether a sign-in encrypted with a keyring is on disk while no keyring is
   * usable (the keyring was removed or is not running): the user is asked to
   * sign in again rather than shown as silently signed out.
   */
  async function keyringCopyUnreadable() {
    try {
      await readFile(filePath);
    } catch {
      return false;
    }
    if (!keyringLossLogged) {
      keyringLossLogged = true;
      log("[mars] The saved sign-in is encrypted with a system keyring that is not usable now; asking to sign in again.");
    }
    return true;
  }

  /** @returns {Promise<AccountStatus>} */
  async function status(input = {}) {
    const sessionId = profileSessionId(input?.sessionId);
    const credentials = await load();
    const configured = await configuredGatewayUrl();
    const gatewayConfigured = Boolean(configured);
    // A connected account reports the server it is actually linked to; a
    // signed-out app reports the server the next sign-in will use.
    const gatewayUrl = credentials?.gatewayUrl ?? configured ?? null;
    const server = { gatewayUrl, gatewayHost: accountServerLabel(gatewayUrl) };
    // Linux without a usable keyring: the sign-in is (or will be) kept in the private file.
    const fileBacked = fileFallback && !(await safeStorage());
    const storage = fileBacked ? { credentialStorage: /** @type {const} */ ("file") } : {};
    if (!credentials) {
      if (fileBacked && await keyringCopyUnreadable()) {
        return { connected: false, gatewayConfigured, ...server, ...storage, reauthorizationRequired: true, keyringUnavailable: true };
      }
      if (signInRequired || (sealedUnreadable && await exists(filePath))) {
        return { connected: false, gatewayConfigured, ...server, ...storage, reauthorizationRequired: true };
      }
      return { connected: false, gatewayConfigured, ...server, ...storage };
    }
    try {
      const profile = await fetchProfile(credentials, 2, sessionId);
      return {
        connected: true,
        gatewayConfigured,
        ...server,
        ...storage,
        credentialKind: credentials.kind,
        email: profile?.email ?? null,
        displayName: profile?.displayName ?? null,
        accountStatus: profile?.status ?? null,
        usage: profile?.usage ?? null,
        clientUpdate: profile?.clientUpdate ?? null,
        quality: profile?.quality ?? null,
      };
    } catch (error) {
      if (error instanceof InvalidAccountCredentialsError) {
        await clear({ revokeRemote: false });
        return {
          connected: false,
          gatewayConfigured,
          ...server,
          ...storage,
          reauthorizationRequired: true,
          email: null,
          displayName: null,
          accountStatus: null,
          usage: null,
          quality: null,
        };
      }
      // Offline profile lookup must not make a securely stored account look
      // signed out. The next 401 (here or in the broker) refreshes again.
      return {
        connected: true,
        gatewayConfigured,
        ...server,
        ...storage,
        credentialKind: credentials.kind,
        email: null,
        displayName: null,
        accountStatus: null,
        usage: null,
        quality: null,
      };
    }
  }

  /**
   * A request to the account server with the device credential, refreshed
   * once on a 401 (as the profile check does). Null while signed out.
   */
  async function sendAuthorized(pathname, init = {}, refreshesLeft = 1, credentials = undefined) {
    const current = credentials === undefined ? await load() : credentials;
    if (!current) return null;
    const url = controlPlaneEndpoint(current.gatewayUrl, pathname);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${current.accessToken}`);
    const response = await send(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(20_000) });
    // An API key cannot be renewed: a 401 on a side request does not end it
    // either way here; the profile check decides the session's fate.
    if (response.status === 401 && refreshesLeft > 0 && current.kind === "oauth") {
      const refreshed = await refresh(current.accessToken);
      if (!refreshed) return response;
      return sendAuthorized(pathname, init, refreshesLeft - 1, refreshed);
    }
    return response;
  }

  /**
   * One diagnostic report (POST /diagnostics/crashes, start-report.mjs).
   * Null while signed out, so the caller queues it.
   */
  async function sendDiagnostic(body) {
    return sendAuthorized("/diagnostics/crashes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * The wheel's segments, the expected payout and the recent sessions with
   * why each did or did not earn spins (GET /me/quality), for the spin
   * dialog and the coaching card. Null while signed out, offline or off.
   */
  async function qualityDetails() {
    try {
      const response = await sendAuthorized("/me/quality", { method: "GET" });
      if (!response?.ok) return null;
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || !payload.quality) return null;
      const expected = Number(payload.expected_tokens);
      const jackpot = Number(payload.jackpot_tokens);
      return {
        segments: parseWheelSegments(payload.segments),
        clientSegments: parseWheelSegments(payload.client_segments),
        expectedTokens: Number.isFinite(expected) ? expected : null,
        jackpotTokens: Number.isFinite(jackpot) && jackpot > 0 ? jackpot : null,
        sessions: parseQualitySessions(payload.sessions),
        failLabels: parseFailLabels(payload.fail_labels),
      };
    } catch {
      return null;
    }
  }

  /**
   * The server's live status for one session (GET /me/sessions/{id}/status),
   * within 3 s. Null while signed out, offline, slow or on a bad answer: the
   * app then shows its own checklist.
   */
  async function sessionStatus(input = {}) {
    const sessionId = profileSessionId(input.sessionId);
    if (!sessionId) return null;
    try {
      const response = await sendAuthorized(`/me/sessions/${encodeURIComponent(sessionId)}/status`, {
        method: "GET",
        signal: AbortSignal.timeout(SESSION_STATUS_TIMEOUT_MS),
      });
      if (!response?.ok) return null;
      return parseSessionStatus(await response.json());
    } catch {
      return null;
    }
  }

  /** GET /me/quality/spins: totals and the last 10 spins; null when unavailable. */
  async function qualitySpinTotals() {
    try {
      const response = await sendAuthorized("/me/quality/spins", { method: "GET" });
      if (!response?.ok) return null;
      return parseSpinHistory(await response.json());
    } catch {
      return null;
    }
  }

  /**
   * One spin of the quality wheel (POST /me/quality/spin). The key comes from
   * the click, so a retry of the same click is answered with the same result.
   * @param {{ idempotencyKey?: string }} [input]
   * @returns {Promise<import("./quality.mjs").QualitySpinOutcome>}
   */
  async function spinQuality(input = {}) {
    const idempotencyKey = spinIdempotencyKey(input.idempotencyKey);
    let response;
    try {
      response = await sendAuthorized("/me/quality/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: idempotencyKey }),
      });
    } catch {
      return { ok: false, reason: "unreachable", status: null };
    }
    if (!response) return { ok: false, reason: "signed_out", status: null };
    const payload = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "signed_out", status: response.status };
    if (response.status === 409) return { ok: false, reason: spinRefusal(payload) ?? "failed", status: 409 };
    if (!response.ok) return { ok: false, reason: "failed", status: response.status };
    const spin = parseSpinResult(payload);
    return spin ? { ok: true, spin } : { ok: false, reason: "failed", status: response.status };
  }

  /**
   * The buildathon block (GET /me/buildathon): a participant's status, a
   * non-participant's promo, or null (no promo, signed out, offline, slow or
   * a bad answer): the app then shows nothing about the event.
   */
  async function buildathonStatus() {
    try {
      const response = await sendAuthorized("/me/buildathon", { method: "GET", signal: AbortSignal.timeout(BUILDATHON_TIMEOUT_MS) });
      if (!response?.ok) return null;
      return parseBuildathonAnswer(await response.json());
    } catch {
      return null;
    }
  }

  /** The event's tagged sessions (GET /me/buildathon/sessions); null when unavailable. */
  async function buildathonSessions() {
    try {
      const response = await sendAuthorized("/me/buildathon/sessions", { method: "GET", signal: AbortSignal.timeout(BUILDATHON_TIMEOUT_MS) });
      if (!response?.ok) return null;
      return parseBuildathonSessions(await response.json());
    } catch {
      return null;
    }
  }

  /**
   * Link a registration made under another email (POST /me/buildathon/link).
   * @param {{ code?: unknown }} [input]
   * @returns {Promise<import("@mars/types/desktop-ipc").MarsBuildathonLinkResult>}
   */
  async function buildathonLink(input = {}) {
    const code = buildathonLinkCode(input.code);
    if (!code) return { ok: false, error: "Enter the code from your registration email." };
    let response;
    try {
      response = await sendAuthorized("/me/buildathon/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(BUILDATHON_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "The code could not be checked. Try again in a moment." };
    }
    if (!response) return { ok: false, error: "Sign in to link a code." };
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: buildathonLinkError(payload, response.status) };
    const status = parseBuildathonStatus(payload);
    return status ? { ok: true, status } : { ok: false, error: "That code is not linked to an event you can join." };
  }

  /**
   * Join the event from the app (POST /me/buildathon/join; only offered when
   * the promo says `join: true`). The answer is the enrolled status.
   * @returns {Promise<import("@mars/types/desktop-ipc").MarsBuildathonLinkResult>}
   */
  async function buildathonJoin() {
    let response;
    try {
      response = await sendAuthorized("/me/buildathon/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(BUILDATHON_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: "Could not join right now. Try again in a moment." };
    }
    if (!response) return { ok: false, error: "Sign in to join." };
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: buildathonJoinError(payload, response.status), closed: response.status === 403 };
    const status = parseBuildathonStatus(payload);
    return status ? { ok: true, status } : { ok: false, error: "Could not join right now. Try again in a moment." };
  }

  /**
   * Name the track of one session (PUT /me/sessions/{id}/buildathon), with
   * the folder's last name. 204 is done; 400/403/404/409 (unknown track, not
   * a participant, outside the event) are final as well; anything else may
   * be tried again later.
   * @param {{ sessionId?: unknown, track?: unknown, project?: unknown }} [input]
   * @returns {Promise<"tagged" | "refused" | "retry">}
   */
  async function buildathonTagSession(input = {}) {
    const sessionId = profileSessionId(input.sessionId);
    const track = buildathonTrackId(input.track);
    const project = buildathonProjectName(input.project);
    if (!sessionId || !track) return "refused";
    try {
      const response = await sendAuthorized(`/me/sessions/${encodeURIComponent(sessionId)}/buildathon`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project ? { track, project } : { track }),
        signal: AbortSignal.timeout(BUILDATHON_TIMEOUT_MS),
      });
      if (!response) return "retry";
      if (response.ok) return "tagged";
      return [400, 403, 404, 409].includes(response.status) ? "refused" : "retry";
    } catch {
      return "retry";
    }
  }

  /**
   * Sign out locally and, for a user-initiated sign-out, revoke the device
   * session remotely and forget the keychain gateway URL so the next sign-in
   * uses the configured default. `revokeRemote: false` is the server-driven
   * invalidation path (the session is already gone), which keeps the gateway
   * URL so re-authorization returns to the same server.
   * @returns {Promise<SignOutOutcome>}
   */
  async function clear({ revokeRemote = true } = {}) {
    // Claim the gate first (synchronously, so no persist slips in), then wait
    // for a rotation still in flight: signing out under it would revoke a
    // retired token (the live session survives) or let its persist land
    // right over the sign-out. A second sign-out waits for the first.
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const signOut = new Promise((resolvePromise) => { release = resolvePromise; });
    const previous = clearInFlight;
    clearInFlight = signOut;
    clearRevokesRemote = revokeRemote;
    try {
      if (previous) await previous;
      await settle({ includeClear: false });
      const credentials = cached ?? await readCredentials();
      /** @type {SignOutOutcome} */
      const outcome = credentials && revokeRemote
        ? await remoteLogout(credentials)
        : { remoteRevoked: true, reason: "already_revoked" };
      await serialize(removeLocalSignIn);
      if (revokeRemote) {
        signInRequired = false;
        await deleteMacKeychain(KEYCHAIN_SERVICES.gatewayUrl, platform, runSecurity);
      }
      return outcome;
    } finally {
      if (clearInFlight === signOut) clearInFlight = null;
      release();
    }
  }

  return {
    load,
    save,
    refresh,
    authorize,
    authorizeApiKey,
    status,
    clear,
    sendDiagnostic,
    qualityDetails,
    qualitySpinTotals,
    spinQuality,
    sessionStatus,
    buildathonStatus,
    buildathonSessions,
    buildathonLink,
    buildathonJoin,
    buildathonTagSession,
  };
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  antivirusHint,
  buildStartFailureReport,
  classifyStartFailure,
  createStartReporter,
  inspectEngineBinary,
  osBuild,
  profileFlags,
  reportVersion,
  engineErrorKind,
  engineErrorLine,
  scrubStartMessage,
  sqliteCodeOf,
  startFailureHint,
} from "./start-report.mjs";

function spawnError(code, errno = -2) {
  return Object.assign(new Error(`spawn C:\\Users\\Ana\\AppData\\Local\\Programs\\marsai.click\\resources\\sidecars\\opencode.exe ${code}`), {
    code,
    errno,
    syscall: "spawn C:\\Users\\Ana\\AppData\\Local\\Programs\\marsai.click\\resources\\sidecars\\opencode.exe",
    path: "C:\\Users\\Ana\\AppData\\Local\\Programs\\marsai.click\\resources\\sidecars\\opencode.exe",
  });
}

function exitError(exitCode, output = "") {
  return Object.assign(new Error(`Mars server exited with code ${exitCode}${output ? `\n${output}` : ""}`), { exitCode });
}

test("start failures are classified from the error the start threw", () => {
  const cases = [
    [spawnError("ENOENT"), "engine_missing", "engine_spawn", "ENOENT", "binary_missing"],
    [spawnError("EPERM"), "engine_blocked", "engine_spawn", "EPERM", "spawn_blocked"],
    [spawnError("UNKNOWN", -4094), "engine_blocked", "engine_spawn", "UNKNOWN", "spawn_blocked"],
    [new Error("Timeout waiting for Mars server after 60000ms"), "engine_timeout", "engine_ready", null, "none"],
    [exitError(3221225501), "engine_cpu_unsupported", "engine_ready", null, "none"],
    [exitError(1, "CPU lacks AVX support. Please consider upgrading to a newer CPU."), "engine_cpu_unsupported", "engine_ready", null, "none"],
    [exitError(3221225506), "engine_blocked", "engine_ready", null, "exec_status_blocked"],
    [exitError(225), "engine_blocked", "engine_ready", null, "virus_detected"],
    [exitError(3221225477), "engine_crash", "engine_ready", null, "none"],
    [exitError(1, "error: Failed to start server. Is port 4096 in use? EADDRINUSE"), "port_in_use", "engine_ready", "EADDRINUSE", "none"],
    [exitError(1, "ConfigJsonError: C:\\Users\\Ana\\.config\\opencode\\opencode.json is not valid JSON"), "config_invalid", "engine_ready", null, "none"],
    [exitError(1, "SQLITE_CORRUPT: database disk image is malformed"), "store_error", "engine_ready", "SQLITE_CORRUPT", "none"],
    [exitError(1, "something else"), "engine_exit", "engine_ready", null, "none"],
    [new Error("Managed Mars process did not exit after SIGKILL"), "engine_stuck", "engine_ready", null, "none"],
    [new Error("Cannot find MarsAI embedded server bundle. Checked: C:\\x"), "server_bundle_missing", "server", null, "none"],
    [new Error("MarsAI server did not stay running after startup."), "server_not_ready", "server_ready", null, "none"],
    [Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }), "disk_full", "server", "ENOSPC", "none"],
    [Object.assign(new Error("Configuration is invalid"), { name: "OpencodeConfigCompatError" }), "config_incompatible", "server", null, "none"],
    [new Error("boom"), "unknown", "unknown", null, "none"],
  ];
  for (const [error, category, phase, errorCode, avHint] of cases) {
    const result = classifyStartFailure(error);
    assert.deepEqual(
      { category: result.category, phase: result.phase, errorCode: result.errorCode, avHint: result.avHint },
      { category, phase, errorCode, avHint },
      String(error instanceof Error ? error.message : error),
    );
  }
  const workspace = Object.assign(new Error("Workspace path is not accessible: D:\\Clients\\Acme"), {
    code: "workspace_inaccessible",
    cause: Object.assign(new Error("EPERM"), { code: "EPERM" }),
  });
  assert.deepEqual(
    (({ category, phase, errorCode }) => ({ category, phase, errorCode }))(classifyStartFailure(workspace)),
    { category: "workspace_inaccessible", phase: "workspace", errorCode: "EPERM" },
  );
  // A failed cleanup wraps the start error: the start error decides.
  const wrapped = new AggregateError([spawnError("ENOENT"), new Error("stop failed")], "startup failed");
  assert.equal(classifyStartFailure(wrapped).category, "engine_missing");
  assert.equal(classifyStartFailure(exitError(3221225477)).exitCode, 3221225477);
  assert.equal(classifyStartFailure("text").errorName, "none");
});

test("messages keep no paths, names, addresses or tokens", () => {
  const roots = ["C:\\Users\\Ana Lucía", "C:\\Users\\Ana Lucía\\AppData\\Roaming\\ai.marsai.desktop"];
  const samples = [
    spawnError("ENOENT"),
    new Error("Workspace path is not accessible: C:\\Users\\Ana Lucía\\OneDrive\\Documents\\work"),
    new Error("EPERM: operation not permitted, open 'C:/Users/Ana Lucía/AppData/Roaming/mars/server.json'"),
    new Error("read \\\\fileserver\\profiles$\\ana\\x failed for ana@example.com"),
    new Error("cannot open /home/ana/.config/opencode/opencode.json (see https://example.com/help)"),
    new Error("token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD rejected for user anaLucia"),
    exitError(1, "ConfigJsonError: ~/.config/opencode/opencode.json bad\nnpm error @opencode-ai/plugin failed"),
  ];
  for (const error of samples) {
    const text = scrubStartMessage(error, { roots, userName: "anaLucia" });
    assert.ok(text, error.message);
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\\\|\/home\/|~[\\/]|@|https?:|Ana|ana|[A-Za-z0-9+/_-]{32,}/, text);
    assert.ok(text.length <= 300);
  }
  assert.equal(scrubStartMessage(spawnError("ENOENT"), { roots }), "spawn <path>");
  assert.equal(scrubStartMessage(new Error("   ")), null);
  assert.match(scrubStartMessage(exitError(1, "line two\nerror: database is locked")), /exited with code 1 \| engine_error=sqlite_busy \| error: database is locked/);
});

// The server's last check (mars/crash_reports.py _PERSONAL): a message
// matching it is dropped. Scrubbed messages must never match it.
const SERVER_DROP = new RegExp([
  String.raw`\\`,
  String.raw`/[^/\s]+/`,
  String.raw`[A-Za-z]:/`,
  String.raw`~/`,
  "@",
  String.raw`[a-z][a-z0-9+.-]*://`,
  String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`,
  String.raw`\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b`,
  "::",
  String.raw`\bBearer\s`,
  String.raw`\bsk-[A-Za-z0-9_-]{4,}`,
  String.raw`\bgh[opsur]_[A-Za-z0-9]{4,}`,
  String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{8,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{4,}`,
  String.raw`[A-Za-z0-9+/_-]{32,}`,
].join("|"), "i");

/** @type {Array<[string, string[]]>} */
const ADVERSARIAL = [
  ["Workspace path is not accessible: C:\\Users\\Bob Jones\\Work\\Acme Client Contract\\notes.txt", ["Bob", "Jones", "Acme", "Contract", "notes"]],
  ["EPERM: operation not permitted, open C:\\Users\\bob\\OneDrive - Acme Corp\\Documents\\plan.docx", ["bob", "Acme", "Corp", "plan"]],
  ["spawn \\Device\\HarddiskVolume3\\Users\\Bob Jones\\x.exe EPERM", ["Bob", "Jones", "Harddisk"]],
  ["cannot read \\Users\\bob\\AppData\\Local\\x", ["bob", "AppData"]],
  ["ENOENT: no such file, open Users/alice/Documents/secret.docx", ["alice", "secret"]],
  ["open '/Users/alice/My Projects/acme plan/x.json' failed", ["alice", "acme", "Projects"]],
  ["provider rejected key sk-live-abc123def456", ["abc123"]],
  ["token ghp_abcdEFGH1234 and gho_zzzz9999 and ghs_yyyy8888 rejected", ["EFGH", "zzzz", "yyyy"]],
  ["request failed: Authorization: Bearer abc.def", ["abc.def"]],
  ["bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", ["eyJ", "c2ln"]],
  ["aws key AKIAIOSFODNN7EXAMPLE denied", ["IOSFODNN"]],
  ["connect ECONNREFUSED 203.0.113.7:443", ["203.0.113"]],
  ["listen failed on fe80::1ff:fe23:4567:890a and 2001:db8:85a3:0:0:8a2e:370:7334", ["fe80", "2001", "8a2e"]],
  ["engine on DESKTOP-BOBPC exited", ["BOBPC"]],
];

test("adversarial messages: paths with spaces, single-backslash and driveless paths, keys, IPs and the computer name never survive", () => {
  for (const [raw, secrets] of ADVERSARIAL) {
    const text = scrubStartMessage(new Error(raw), { userName: "bob", hostName: "DESKTOP-BOBPC" });
    assert.ok(text, raw);
    for (const secret of secrets) assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `${raw} -> ${text} keeps ${secret}`);
    assert.doesNotMatch(text, SERVER_DROP, `${raw} -> ${text} would be dropped by the server`);
  }
  // Every raw string (except the computer name, which only the client knows) is dropped by the server's check.
  for (const [raw] of ADVERSARIAL.slice(0, -1)) assert.match(raw, SERVER_DROP, raw);
});

test("config errors send only the error's type name, never the quoted diagnostic", () => {
  const invalid = exitError(1, "ConfigJsonError: C:\\Users\\Bob Jones\\.config\\opencode\\opencode.json: Unexpected token at 'apiKey: sk-abc'");
  assert.equal(scrubStartMessage(invalid, { category: classifyStartFailure(invalid).category }), "ConfigJsonError");
  const compat = Object.assign(new Error("Configuration is invalid at C:\\Users\\Bob\\.config\\opencode\\opencode.json: permissions"), { name: "OpencodeConfigCompatError" });
  assert.equal(scrubStartMessage(compat, { category: "config_incompatible" }), "OpencodeConfigCompatError");
  assert.equal(scrubStartMessage(new Error("Configuration is invalid at x"), { category: "config_invalid" }), "config_invalid");
});

test("profile, OS build and version fields are booleans or numbers only", () => {
  assert.deepEqual(profileFlags("C:\\Users\\José"), { non_ascii: true, has_space: false, unc: false, long: false });
  assert.deepEqual(profileFlags("C:\\Users\\Ana Lucia"), { non_ascii: false, has_space: true, unc: false, long: false });
  assert.equal(profileFlags("\\\\server\\profiles\\ana").unc, true);
  assert.equal(profileFlags(`C:\\Users\\${"x".repeat(90)}`).long, true);
  assert.equal(osBuild("10.0.26100"), "10.0.26100");
  assert.equal(osBuild("6.8.0-139-generic"), "6.8.0");
  assert.equal(osBuild("weird"), "unknown");
  assert.equal(reportVersion("v1.18.32"), "1.18.32");
  assert.equal(reportVersion("3.5.3-beta.1"), "3.5.3-beta.1");
  assert.equal(reportVersion(undefined), "unknown");
});

test("engine binary checks: missing, present and matching, modified", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "start-report-"));
  const binary = path.join(dir, "opencode.exe");
  const body = Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(64, 1)]);
  await writeFile(binary, body);
  const sha256 = createHash("sha256").update(body).digest("hex");

  const missing = await inspectEngineBinary({ resolved: null, bundledCandidates: [binary + ".gone"], platform: "win32" });
  assert.deepEqual(missing, { source: "missing", present: false, bundled_present: false, size: null, header_ok: null, hash_ok: null, readable: null });
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), missing), "binary_missing");
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), missing, { packaged: false }), "none");

  const ok = await inspectEngineBinary({
    resolved: { path: binary, source: "bundled" },
    bundledCandidates: [binary],
    versions: { opencode: { version: "1.18.32", sha256 } },
    platform: "win32",
  });
  assert.deepEqual(ok, { source: "bundled", present: true, bundled_present: true, size: body.length, header_ok: true, hash_ok: true, readable: true });
  assert.equal(antivirusHint(classifyStartFailure(new Error("x")), ok), "none");

  const modified = await inspectEngineBinary({
    resolved: { path: binary, source: "bundled" },
    bundledCandidates: [binary],
    versions: { opencode: { sha256: "0".repeat(64) } },
    platform: "linux",
  });
  assert.equal(modified.hash_ok, false);
  assert.equal(modified.header_ok, false);
  assert.equal(antivirusHint(classifyStartFailure(exitError(1)), modified), "binary_modified");
});

test("the report body carries only the server's fields", () => {
  const classified = classifyStartFailure(spawnError("ENOENT"));
  const engine = { source: "missing", present: false, bundled_present: false, size: null, header_ok: null, hash_ok: null, readable: null };
  const report = buildStartFailureReport({
    classified,
    engine,
    avHint: antivirusHint(classified, engine),
    message: "spawn <path>",
    appVersion: "3.5.3",
    engineVersion: "1.18.32",
    electronVersion: "38.2.0",
    platform: "win32",
    arch: "x64",
    release: "10.0.26100",
    home: "C:\\Users\\José Ñ",
    elapsedMs: 1234.4,
    attempt: 2,
    occurredAt: new Date("2026-10-17T10:00:00Z"),
    eventId: "a".repeat(64),
  });
  assert.deepEqual(report, {
    schema_version: 1,
    product: "gui",
    kind: "start_failure",
    event_id: "a".repeat(64),
    occurred_at: "2026-10-17T10:00:00.000Z",
    app_version: "3.5.3",
    engine_version: "1.18.32",
    runtime: "electron",
    runtime_version: "38.2.0",
    platform: "win32",
    arch: "x64",
    os_build: "10.0.26100",
    phase: "engine_spawn",
    category: "engine_missing",
    error_name: "Error",
    error_code: "ENOENT",
    exit_code: null,
    signal: null,
    elapsed_ms: 1234,
    attempt: 2,
    engine,
    profile: { non_ascii: true, has_space: true, unc: false, long: false },
    av_hint: "binary_missing",
    message: "spawn <path>",
  });
  assert.doesNotMatch(JSON.stringify(report), /José|Users/);
  // ENOENT although the binary is there: something stopped it.
  const blocked = buildStartFailureReport({ classified, engine: { ...engine, present: true, bundled_present: true }, avHint: "spawn_blocked", appVersion: "3.5.3" });
  assert.equal(blocked.category, "engine_blocked");
  const modified = buildStartFailureReport({ classified: classifyStartFailure(exitError(1)), engine, avHint: "binary_modified", appVersion: "x" });
  assert.equal(modified.category, "engine_modified");
  assert.equal(modified.app_version, "unknown");
});

test("hints name the antivirus fix on Windows and stay null for unknown failures", () => {
  assert.match(startFailureHint("engine_missing", { platform: "win32" }).body, /Protection history/);
  assert.match(startFailureHint("unknown", { platform: "win32", avHint: "binary_missing" }).title, /antivirus/);
  assert.match(startFailureHint("engine_timeout", { platform: "win32" }).body, /exclusion/);
  assert.match(startFailureHint("engine_cpu_unsupported").title, /processor is too old/);
  assert.doesNotMatch(JSON.stringify(startFailureHint("engine_cpu_unsupported")), /AVX/);
  assert.match(startFailureHint("store_error").body, /Reset app data/);
  assert.equal(startFailureHint("unknown"), null);
  assert.equal(startFailureHint("renderer"), null);
});

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

test("reporter: once sent, queued while signed out, capped per day, flushed later", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "start-reporter-"));
  const filePath = path.join(dir, "start-reports.json");
  let nowMs = Date.parse("2026-10-17T10:00:00Z");
  const sent = [];
  let answer = null;
  const reporter = createStartReporter({
    filePath,
    now: () => nowMs,
    maxPerDay: 3,
    send: async (body) => {
      sent.push(body.event_id);
      return answer;
    },
  });
  const body = (id) => ({ event_id: id, occurred_at: new Date(nowMs).toISOString() });

  // Signed out: queued.
  assert.equal(await reporter.report(body("a")), "queued");
  answer = response(201);
  assert.equal(await reporter.report(body("b")), "sent");
  answer = response(400);
  assert.equal(await reporter.report(body("c")), "dropped");
  // The day's cap counts every attempt.
  assert.equal(await reporter.report(body("d")), "skipped");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).queue.map((item) => item.event_id), ["a"]);

  // Next day, offline: queued; the next start's flush sends both.
  nowMs += 24 * 60 * 60 * 1000;
  answer = null;
  assert.equal(await reporter.report(body("e")), "queued");
  answer = response(201);
  assert.deepEqual(await reporter.flush(), { sent: 2, queued: 0 });
  assert.deepEqual(sent, ["a", "b", "c", "e", "a", "e"]);

  // A server error keeps the queue; reports older than six days are dropped.
  answer = response(503);
  assert.equal(await reporter.report(body("f")), "queued");
  nowMs += 7 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await reporter.flush(), { sent: 0, queued: 0 });

  // A failing transport never throws.
  const failing = createStartReporter({ filePath: path.join(dir, "other.json"), send: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(await failing.report(body("g")), "queued");
});

/** node:sqlite's error for a write to a read-only file, or a read-only read that met a hot journal (776). */
function nodeSqliteError(errcode, errstr) {
  return Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
}

test("a read-only store is its own category, in the server and in the engine", () => {
  // The 3.5.4 reports: phase/category "unknown", error_code null.
  for (const errcode of [8, 776, 1032]) {
    const result = classifyStartFailure(nodeSqliteError(errcode, "attempt to write a readonly database"));
    assert.deepEqual(
      { category: result.category, phase: result.phase, errorCode: result.errorCode },
      { category: "store_readonly", phase: "server", errorCode: "SQLITE_READONLY" },
    );
  }
  const tagged = Object.assign(new Error("attempt to write a readonly database (runtime store)"), { code: "SQLITE_READONLY" });
  assert.equal(classifyStartFailure(tagged).category, "store_readonly");
  // Only the text left (the window's message): still recognised.
  assert.equal(classifyStartFailure(new Error("attempt to write a readonly database")).category, "store_readonly");
  const engine = exitError(1, "\u001b[91m\u001b[1mError: \u001b[0mUnexpected error\nattempt to write a readonly database");
  assert.deepEqual(
    (({ category, phase, errorCode }) => ({ category, phase, errorCode }))(classifyStartFailure(engine)),
    { category: "store_readonly", phase: "engine_ready", errorCode: "SQLITE_READONLY" },
  );
  assert.equal(classifyStartFailure(nodeSqliteError(5, "database is locked")).errorCode, "SQLITE_BUSY");
  assert.equal(classifyStartFailure(nodeSqliteError(11, "database disk image is malformed")).category, "store_error");
  assert.equal(sqliteCodeOf(null, "SQLiteError: SQLITE_READONLY_ROLLBACK"), "SQLITE_READONLY");
  assert.equal(sqliteCodeOf(null, "nothing"), null);
});

test("an engine exit keeps the engine's own error line and its kind", () => {
  // Report B: the banner was kept and the engine's line after it was lost.
  const banner = "\u001b[91m\u001b[1mError: \u001b[0mUnexpected error";
  const cases = [
    ["attempt to write a readonly database", "sqlite_readonly"],
    ["database is locked", "sqlite_busy"],
    ["EPERM: operation not permitted, rename 'C:\\Users\\Ana\\AppData\\Roaming\\ai.marsai.desktop\\engine-data\\mars\\x.tmp'", "eperm"],
    ["Migration 20260101_session failed", "migration"],
    ["JSON Parse error: Unexpected EOF", "json"],
    // What the engine printed on the VM with a read-only opencode.db.
    ["Failed query: PRAGMA wal_checkpoint(PASSIVE)", "sqlite_query"],
    ["undefined is not an object (evaluating 'x.y')", "internal"],
    ["something unusual", "other"],
  ];
  for (const [line, kind] of cases) {
    const error = exitError(1, `${banner}\n${line}\n    at foo (C:\\x\\y.js:1:2)`);
    assert.equal(engineErrorLine(error.message), line);
    assert.equal(engineErrorKind(line), kind);
    const text = scrubStartMessage(error, { roots: ["C:\\Users\\Ana"], userName: "Ana" });
    assert.ok(text.startsWith(`Mars server exited with code 1 | engine_error=${kind} | `), text);
    assert.doesNotMatch(text, /\u001b|Unexpected error|Ana|\\/, text);
    assert.doesNotMatch(text, SERVER_DROP, text);
  }
  const checkpoint = exitError(1, `${banner}\nFailed query: PRAGMA wal_checkpoint(PASSIVE)`);
  assert.deepEqual(
    (({ category, phase }) => ({ category, phase }))(classifyStartFailure(checkpoint)),
    { category: "store_error", phase: "engine_ready" },
  );
  assert.equal(engineErrorLine("boom"), null);
  assert.equal(engineErrorKind(null), "none");
});

test("the read-only hint names the fix", () => {
  const plain = startFailureHint("store_readonly", { platform: "win32", storeCheck: { repairable: true, elevated: false } });
  assert.match(plain.title, /can't write its local data/);
  assert.match(plain.body, /read-only.*Fix and restart/);
  const denied = startFailureHint("store_readonly", { platform: "win32", storeCheck: { repairable: false, elevated: false } });
  assert.match(denied.body, /^Windows refuses.*Use Reset app data/);
  assert.doesNotMatch(denied.body, /Fix and restart/);
  assert.match(denied.body, /Run as administrator/);
  const admin = startFailureHint("store_readonly", { platform: "win32", storeCheck: { repairable: false, elevated: true } });
  assert.match(admin.title, /running as administrator/);
  assert.ok(startFailureHint("store_readonly", { platform: "linux" }));
});

test("a server that does not know store_readonly gets store_error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "start-report-legacy-"));
  const sent = [];
  const reporter = createStartReporter({
    filePath: path.join(dir, "start-reports.json"),
    send: async (body) => {
      sent.push(body.category);
      return body.category === "store_readonly" ? { ok: false, status: 422 } : { ok: true, status: 200 };
    },
  });
  assert.equal(await reporter.report({ category: "store_readonly", occurred_at: new Date().toISOString() }), "sent");
  assert.deepEqual(sent, ["store_readonly", "store_error"]);
});

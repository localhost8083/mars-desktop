import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUILDATHON_TRACKS,
  DEFAULT_AGENT_RULES,
  buildathonLinkCode,
  buildathonTrackId,
  parseBuildathonAnnouncements,
  parseBuildathonAnswer,
  parseBuildathonPromo,
  parseBuildathonRepro,
  parseBuildathonSessions,
  parseBuildathonStatus,
  parseBuildathonSubmission,
} from "./buildathon.mjs";
import { DEFAULT_CHECKLIST, evaluateChecklist, projectChecklist } from "./buildathon-checklist.mjs";
import { createDesktopMarsAccountStore } from "./mars-account.mjs";

const GATEWAY = "http://127.0.0.1:8000/v1";
const SUBMISSION = {
  submission_id: "OFB-4K7Q9M",
  submitted_at: "2026-10-18T10:00:00Z",
  updated_at: "2026-10-18T11:00:00Z",
  track: "agents",
  title: "Thing",
  repo_url: "https://github.com/a/b",
  demo_video_url: "https://youtu.be/x",
  live_url: "http://insecure.example",
  description: "d",
  session_ids: ["ses_1", 7],
  checks: [{ id: "repo_public", ok: true, text: "Repo is public" }, { ok: false }],
  locked: false,
};
const ENROLLED = {
  enrolled: true,
  server_time: "2026-10-15T10:00:00Z",
  event: {
    id: "frontier-2026",
    name: "Mars Frontier Buildathon 2026",
    starts_at: "2026-10-13T18:30:00Z",
    registration_ends_at: "2026-10-19T18:29:59Z",
    deadline_at: "2026-10-20T18:29:59Z",
    results_at: "2026-10-25T06:30:00Z",
    phase: "building",
    page_url: "https://unstop.com/p/x",
    submit_url: "https://marsai.click/console/buildathon",
    rules: ["Mars must be the only generative AI tool you use.", "", "Individual only."],
    tracks: [{ id: "agents", label: "Agents & Automation" }, { id: "BAD ID", label: "x" }],
    reminders: [{ before_s: 900, text: "15 min" }, { before_s: 86400, text: "24 h" }, { before_s: 3600, text: "1 h" }, { before_s: 0, text: "no" }],
  },
  participant: { enrolled_at: "2026-10-14T00:00:00Z", tokens_granted: 10000000, tokens_used: 1234567, tokens_left: 8765433, sessions_tagged: 12, sessions_good: 7 },
  submission: null,
};

function testStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptStringAsync: async (value) => Buffer.from(value, "utf8"),
    decryptStringAsync: async (value) => ({ result: value.toString("utf8"), shouldReEncrypt: false }),
  };
}

async function signedInStore(fetchImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mars-buildathon-"));
  const store = createDesktopMarsAccountStore({
    filePath: path.join(directory, "account.bin"),
    loadSafeStorage: () => testStorage(),
    platform: /** @type {NodeJS.Platform} */ ("linux"),
    env: { MARS_DEV_MODE: "1" },
    sleep: async () => undefined,
    execFileImpl: async (file) => { throw new Error(`unexpected ${file}`); },
    clientVersion: "3.4.9",
    fetchImpl,
  });
  await store.save({ gatewayUrl: GATEWAY, accessToken: "access-1", refreshToken: "refresh-1" });
  return store;
}

test("buildathon: anything but an enrolled answer with a deadline is null", () => {
  assert.equal(parseBuildathonStatus(null), null);
  assert.equal(parseBuildathonStatus({ enrolled: false }), null);
  assert.equal(parseBuildathonStatus({ enrolled: "true", event: ENROLLED.event }), null);
  assert.equal(parseBuildathonStatus({ enrolled: true }), null);
  assert.equal(parseBuildathonStatus({ enrolled: true, event: { ...ENROLLED.event, deadline_at: "soon" } }), null);
  assert.equal(parseBuildathonStatus([]), null);
});

test("buildathon: the enrolled block, cleaned", () => {
  const status = parseBuildathonStatus(ENROLLED);
  assert.equal(status.enrolled, true);
  assert.equal(status.event.id, "frontier-2026");
  assert.equal(status.event.phase, "building");
  assert.equal(status.event.deadlineAt, "2026-10-20T18:29:59Z");
  assert.deepEqual(status.event.rules, ["Mars must be the only generative AI tool you use.", "Individual only."]);
  assert.deepEqual(status.event.tracks, [{ id: "agents", label: "Agents & Automation" }]);
  assert.deepEqual(status.event.reminders.map((reminder) => reminder.beforeSeconds), [86400, 3600, 900]);
  assert.equal(status.participant.tokensLeft, 8765433);
  assert.equal(status.participant.sessionsGood, 7);
  assert.equal(status.submission, null);
});

test("buildathon: the six tracks stand in when the server lists none", () => {
  const status = parseBuildathonStatus({ ...ENROLLED, event: { ...ENROLLED.event, tracks: [], phase: "odd", submit_url: "javascript:alert(1)" } });
  assert.deepEqual(status.event.tracks.map((track) => track.id), BUILDATHON_TRACKS.map((track) => track.id));
  assert.equal(status.event.tracks.length, 6);
  assert.equal(status.event.phase, null);
  assert.equal(status.event.submitUrl, null);
});

test("buildathon: tokens left defaults to granted minus used", () => {
  const status = parseBuildathonStatus({ ...ENROLLED, participant: { tokens_granted: 10000000, tokens_used: 4000000 } });
  assert.equal(status.participant.tokensLeft, 6000000);
});

test("buildathon: the submission object", () => {
  const submission = parseBuildathonSubmission(SUBMISSION);
  assert.equal(submission.submissionId, "OFB-4K7Q9M");
  assert.equal(submission.liveUrl, null, "only https links are kept");
  assert.deepEqual(submission.sessionIds, ["ses_1"]);
  assert.deepEqual(submission.checks, [{ id: "repo_public", ok: true, text: "Repo is public" }]);
  assert.equal(parseBuildathonSubmission({}), null);
  assert.equal(parseBuildathonStatus({ ...ENROLLED, submission: SUBMISSION }).submission.submissionId, "OFB-4K7Q9M");
});

test("buildathon: tagged sessions", () => {
  const sessions = parseBuildathonSessions({
    sessions: [
      { session_id: "ses_1", title: "API", project: "app", started_at: "2026-10-15T01:00:00Z", track: "agents", status: "good", reasons: [], tokens: 12000 },
      { session_id: "ses_2", status: "weird", reasons: ["Too short", ""] },
      { title: "no id" },
    ],
  });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].status, "good");
  assert.equal(sessions[1].status, "pending");
  assert.deepEqual(sessions[1].reasons, ["Too short"]);
  assert.equal(parseBuildathonSessions({}), null);
});

test("buildathon: track ids and link codes", () => {
  assert.equal(buildathonTrackId("Human-AI"), "human-ai");
  assert.equal(buildathonTrackId("../x"), null);
  assert.equal(buildathonLinkCode(" fb-7kq2-m9 "), "FB-7KQ2-M9");
  assert.equal(buildathonLinkCode("x"), null);
  assert.equal(buildathonLinkCode("FB/../.."), null);
});

test("buildathon store: GET /me/buildathon with the device credential; null for not enrolled, errors, timeouts", async () => {
  const seen = [];
  const store = await signedInStore(async (url, init) => {
    seen.push({ path: new URL(url).pathname, authorization: new Headers(init.headers).get("authorization"), signal: init.signal instanceof AbortSignal });
    return Response.json(ENROLLED);
  });
  assert.equal(/** @type {any} */ (await store.buildathonStatus()).event.id, "frontier-2026");
  assert.deepEqual(seen, [{ path: "/mars/me/buildathon", authorization: "Bearer access-1", signal: true }]);

  for (const fetchImpl of [
    async () => Response.json({ enrolled: false }),
    async () => new Response("nope", { status: 404 }),
    async () => new Response("down", { status: 500 }),
    async () => new Response("not json", { status: 200 }),
    async () => { throw new TypeError("fetch failed"); },
    async () => { throw new DOMException("The operation timed out.", "TimeoutError"); },
  ]) {
    const other = await signedInStore(fetchImpl);
    assert.equal(await other.buildathonStatus(), null);
    assert.equal(await other.buildathonSessions(), null);
  }
});

test("buildathon store: PUT the track of a session; 204 tagged, 404 refused, 5xx retry", async () => {
  const seen = [];
  const store = await signedInStore(async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, body: init.body });
    return new Response(null, { status: 204 });
  });
  assert.equal(await store.buildathonTagSession({ sessionId: "ses_abc", track: "agents", project: "/home/a/shipwright" }), "tagged");
  assert.deepEqual(seen, [{ path: "/mars/me/sessions/ses_abc/buildathon", method: "PUT", body: JSON.stringify({ track: "agents", project: "shipwright" }) }]);
  assert.equal(await store.buildathonTagSession({ sessionId: "../me", track: "agents" }), "refused");
  assert.equal(await store.buildathonTagSession({ sessionId: "ses_abc", track: "" }), "refused");
  assert.equal(seen.length, 1, "bad input never reaches the server");

  const notParticipant = await signedInStore(async () => Response.json({ detail: "Not Found" }, { status: 404 }));
  assert.equal(await notParticipant.buildathonTagSession({ sessionId: "ses_abc", track: "agents" }), "refused");
  const outside = await signedInStore(async () => Response.json({ error: "outside_window" }, { status: 409 }));
  assert.equal(await outside.buildathonTagSession({ sessionId: "ses_abc", track: "agents" }), "refused");
  const down = await signedInStore(async () => new Response("down", { status: 503 }));
  assert.equal(await down.buildathonTagSession({ sessionId: "ses_abc", track: "agents" }), "retry");
  const offline = await signedInStore(async () => { throw new TypeError("fetch failed"); });
  assert.equal(await offline.buildathonTagSession({ sessionId: "ses_abc", track: "agents" }), "retry");
});

test("buildathon store: link code", async () => {
  const seen = [];
  const store = await signedInStore(async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, body: init.body });
    return Response.json(ENROLLED);
  });
  const linked = await store.buildathonLink({ code: "fb-7kq2-m9" });
  assert.equal(linked.ok, true);
  assert.equal(linked.status.event.id, "frontier-2026");
  assert.deepEqual(seen, [{ path: "/mars/me/buildathon/link", method: "POST", body: JSON.stringify({ code: "FB-7KQ2-M9" }) }]);
  assert.equal((await store.buildathonLink({ code: "" })).ok, false);

  const refused = await signedInStore(async () => Response.json({ error: "code_already_used" }, { status: 400 }));
  assert.deepEqual(await refused.buildathonLink({ code: "FB-0000-00" }), { ok: false, error: "That code was already used." });
  const unknown = await signedInStore(async () => Response.json({ error: "some_new_code" }, { status: 400 }));
  assert.match(/** @type {any} */ (await unknown.buildathonLink({ code: "FB-0000-00" })).error, /not found/);
  const limited = await signedInStore(async () => Response.json({ error: "too_many_attempts" }, { status: 429 }));
  assert.match(/** @type {any} */ (await limited.buildathonLink({ code: "FB-0000-00" })).error, /Too many tries/);
  const offline = await signedInStore(async () => { throw new TypeError("fetch failed"); });
  assert.equal((await offline.buildathonLink({ code: "FB-0000-00" })).ok, false);
});

test("repro block: the server's values, else the contract's defaults (box on)", () => {
  const none = parseBuildathonRepro(undefined);
  assert.equal(none.box, "on");
  assert.equal(none.agentRules, DEFAULT_AGENT_RULES);
  assert.deepEqual(none.checklist.map((c) => c.id), ["git", "lockfile", "runtime_pin", "dockerfile", "test_cmd", "readme", "env_example", "no_abs_paths"]);
  const server = parseBuildathonRepro({ box: "offer", agent_rules: "Use make.", checklist: [{ id: "git" }, { id: "custom", text: "Custom" }, { bad: 1 }] });
  assert.equal(server.box, "offer");
  assert.equal(server.agentRules, "Use make.");
  assert.deepEqual(server.checklist, [{ id: "git", text: DEFAULT_CHECKLIST[0].text }, { id: "custom", text: "Custom" }]);
  assert.equal(parseBuildathonRepro({ box: "maybe" }).box, "on");
  assert.equal(parseBuildathonStatus(ENROLLED).repro.box, "on", "parsed with the rest of the answer");
});

test("repro: the default rules are the contract's text, word for word", async () => {
  const contract = "This project is part of the Mars Buildathon and must rebuild from scratch on a clean Linux machine. Keep every file the project needs inside this folder and use git, committing after each working step. Pin the runtime version (.nvmrc / .python-version / go.mod toolchain / rust-toolchain.toml) and always keep a lockfile; install dependencies only into the project (no global installs, no sudo outside the Dockerfile). Maintain a Dockerfile that installs every system package and dependency and can build and run the project, a single test command (e.g. `make test`) that works offline, and a README with exact setup, run, test and deploy steps. Never hard-code absolute paths from this machine or put secrets in files (use .env.example). After each change, run the tests.";
  assert.equal(DEFAULT_AGENT_RULES, contract);
  const server = await readFile(new URL("../../server/src/buildathon-repro.ts", import.meta.url), "utf8");
  assert.ok(server.includes(JSON.stringify(contract)), "the server embeds the same text");
});

function project(prefix = "mars-bt-proj-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("checklist: cheap checks in the folder, pass and fail", () => {
  const bare = project();
  const results = evaluateChecklist(bare, DEFAULT_CHECKLIST, { home: "/home/nobody" });
  const ok = Object.fromEntries(results.map((r) => [r.id, r.ok]));
  assert.deepEqual(ok, { git: false, lockfile: false, runtime_pin: false, dockerfile: false, test_cmd: false, readme: false, env_example: true, no_abs_paths: true });

  const good = project();
  mkdirSync(path.join(good, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(path.join(good, "src"));
  writeFileSync(path.join(good, ".git", "refs", "heads", "main"), "abc\n");
  writeFileSync(path.join(good, "package.json"), JSON.stringify({ engines: { node: "22" }, scripts: { test: "node --test" } }));
  writeFileSync(path.join(good, "package-lock.json"), "{}");
  writeFileSync(path.join(good, "Dockerfile"), "FROM node:22\n");
  writeFileSync(path.join(good, "README.md"), "# app\n");
  writeFileSync(path.join(good, ".env"), "KEY=1\n");
  writeFileSync(path.join(good, ".env.example"), "KEY=\n");
  writeFileSync(path.join(good, "src", "a.js"), "export const p = './data';\n");
  const all = evaluateChecklist(good, [...DEFAULT_CHECKLIST, { id: "future", text: "Future" }], { home: "/home/alice" });
  assert.deepEqual(all.map((r) => r.ok), [true, true, true, true, true, true, true, true, null]);

  writeFileSync(path.join(good, "src", "b.py"), 'DATA = "/home/alice/datasets/x.csv"\n');
  assert.equal(evaluateChecklist(good, [{ id: "no_abs_paths", text: "x" }], { home: "/home/alice" })[0].ok, false);
  rmSync(path.join(good, ".env.example"));
  assert.equal(evaluateChecklist(good, [{ id: "env_example", text: "x" }], { home: "/home/alice" })[0].ok, false, ".env without an example");
});

test("checklist IPC: an existing project folder only, never home, a root or a relative path", () => {
  const dir = project();
  assert.equal(projectChecklist({ path: dir, checklist: [] }).length, 8, "the default list when none is sent");
  assert.equal(projectChecklist({ path: os.homedir() }), null);
  assert.equal(projectChecklist({ path: "/" }), null);
  assert.equal(projectChecklist({ path: "relative/dir" }), null);
  assert.equal(projectChecklist({ path: path.join(dir, "missing") }), null);
  assert.equal(projectChecklist({}), null);
});

const PROMO = {
  id: "frontier-2026-reg",
  title: "Frontier Buildathon 2026",
  text: "$300 prize pool · $300 of GPT-6 tokens each · solo · 6 days",
  cta_label: "Join the Buildathon",
  cta_url: "https://marsai.click/buildathon",
  ends_at: "2026-10-19T18:29:59Z",
  join: false,
};

test("promo: a non-participant's promo block, cleaned", () => {
  assert.deepEqual(parseBuildathonPromo(PROMO), {
    id: "frontier-2026-reg",
    title: "Frontier Buildathon 2026",
    text: "$300 prize pool · $300 of GPT-6 tokens each · solo · 6 days",
    ctaLabel: "Join the Buildathon",
    ctaUrl: "https://marsai.click/buildathon",
    endsAt: "2026-10-19T18:29:59Z",
    join: false,
    joinUrl: null,
  });
  // Open joining on the web.
  const open = parseBuildathonPromo({ ...PROMO, join: true, join_url: "https://marsai.click/console/buildathon?join=1" });
  assert.equal(open.joinUrl, "https://marsai.click/console/buildathon?join=1");
  assert.equal(parseBuildathonPromo({ ...PROMO, join_url: "https://marsai.click/console/buildathon?join=1" }).joinUrl, null, "no join_url unless join is on");
  assert.equal(parseBuildathonPromo({ ...PROMO, join: true, join_url: "http://marsai.click/x" }).joinUrl, null);
  // Defaults and cleaning.
  const bare = parseBuildathonPromo({ id: "p1", title: "T", cta_url: "https://x.example/" , join: "yes" });
  assert.equal(bare.ctaLabel, "Join the Buildathon");
  assert.equal(bare.join, false, "only a literal true joins in the app");
  assert.equal(bare.text, null);
  assert.equal(bare.endsAt, null);
  // In-app join needs no page.
  assert.equal(parseBuildathonPromo({ id: "p1", title: "T", join: true }).join, true);
  // Unusable: no id, a bad id, no title, no way to act (no join, no https page).
  for (const bad of [null, [], { ...PROMO, id: "" }, { ...PROMO, id: "has space" }, { ...PROMO, title: " " },
    { ...PROMO, cta_url: "http://marsai.click/buildathon" }, { ...PROMO, cta_url: "javascript:alert(1)" }]) {
    assert.equal(parseBuildathonPromo(bad), null, JSON.stringify(bad));
  }
});

test("promo: GET /me/buildathon reads as status, promo or nothing", () => {
  assert.equal(parseBuildathonAnswer({ enrolled: false }), null, "no promo: nothing, as before");
  assert.equal(parseBuildathonAnswer({ enrolled: false, promo: { id: "x" } }), null);
  assert.deepEqual(parseBuildathonAnswer({ enrolled: false, promo: PROMO, server_time: "2026-10-15T10:00:00Z" }), {
    enrolled: false,
    serverTime: "2026-10-15T10:00:00Z",
    promo: parseBuildathonPromo(PROMO),
  });
  assert.equal(parseBuildathonAnswer({ promo: PROMO }), null, "enrolled must be false, not missing");
  const status = parseBuildathonAnswer({ ...ENROLLED, promo: PROMO });
  assert.equal(status.enrolled, true);
  assert.equal("promo" in status, false, "participants never get the promo");
});

test("announcements: newest first, at most 20, cleaned", () => {
  const list = parseBuildathonAnnouncements([
    { id: "a_1", title: "Old", body: "first", url: null, level: "info", published_at: "2026-10-14T10:00:00Z" },
    { id: "a_2", title: "New", body: "see https://marsai.click/x", url: "https://marsai.click/x", level: "important", published_at: "2026-10-15T10:00:00Z" },
    { id: "a_2", title: "dup", body: "dup" },
    { id: "a_3", body: "body only", url: "http://insecure.example", level: "loud" },
    { id: "", title: "no id" },
    { id: "a_4" },
    "junk",
  ]);
  assert.deepEqual(list.map((a) => a.id), ["a_2", "a_1", "a_3"]);
  assert.equal(list[0].level, "important");
  assert.equal(list[0].url, "https://marsai.click/x");
  assert.equal(list[2].title, "Update");
  assert.equal(list[2].url, null);
  assert.equal(list[2].level, "info");
  const many = Array.from({ length: 30 }, (_, index) => ({ id: `a_${index}`, title: `t${index}`, published_at: new Date(Date.UTC(2026, 9, 14, index % 24, index)).toISOString() }));
  assert.equal(parseBuildathonAnnouncements(many).length, 20);
  assert.deepEqual(parseBuildathonAnnouncements(undefined), []);
  assert.deepEqual(parseBuildathonStatus(ENROLLED).announcements, []);
  assert.equal(parseBuildathonStatus(ENROLLED).github, null);
  assert.deepEqual(parseBuildathonStatus({ ...ENROLLED, github: { login: "octo-cat", linked_at: "2026-10-14T19:30:00Z" } }).github, { login: "octo-cat", linkedAt: "2026-10-14T19:30:00Z" });
  assert.equal(parseBuildathonStatus({ ...ENROLLED, github: { login: "bad login!" } }).github, null);
  assert.equal(parseBuildathonStatus({ ...ENROLLED, announcements: [{ id: "a_1", title: "Hi" }] }).announcements[0].title, "Hi");
});

test("buildathon store: the promo comes through GET /me/buildathon", async () => {
  const store = await signedInStore(async () => Response.json({ enrolled: false, promo: PROMO }));
  const answer = await store.buildathonStatus();
  assert.equal(answer.enrolled, false);
  assert.equal(answer.promo.id, "frontier-2026-reg");
});

test("buildathon store: join; the enrolled status, or the refusal in words", async () => {
  const seen = [];
  const store = await signedInStore(async (url, init) => {
    seen.push({ path: new URL(url).pathname, method: init.method, authorization: new Headers(init.headers).get("authorization") });
    return Response.json({ ...ENROLLED, announcements: [{ id: "a_1", title: "Welcome" }] });
  });
  const joined = await store.buildathonJoin();
  assert.equal(joined.ok, true);
  assert.equal(joined.status.event.id, "frontier-2026");
  assert.equal(joined.status.announcements[0].id, "a_1");
  assert.deepEqual(seen, [{ path: "/mars/me/buildathon/join", method: "POST", authorization: "Bearer access-1" }]);

  const closed = await signedInStore(async () => Response.json({ error: "join_closed" }, { status: 403 }));
  assert.deepEqual(await closed.buildathonJoin(), { ok: false, error: "Joining is closed right now.", closed: true });
  for (const [code, words] of /** @type {Array<[string, RegExp]>} */ ([["github_required", /Link your GitHub/], ["github_too_new", /3 days old/], ["github_inactive", /public activity/], ["github_in_use", /another Mars account/]])) {
    const refused = await signedInStore(async () => Response.json({ error: code }, { status: 403 }));
    assert.match(/** @type {any} */ (await refused.buildathonJoin()).error, words, code);
  }
  const odd = await signedInStore(async () => Response.json({ enrolled: false }));
  assert.equal((await odd.buildathonJoin()).ok, false);
  const down = await signedInStore(async () => new Response("down", { status: 502 }));
  assert.match(/** @type {any} */ (await down.buildathonJoin()).error, /Try again/);
  const offline = await signedInStore(async () => { throw new TypeError("fetch failed"); });
  assert.equal((await offline.buildathonJoin()).ok, false);
});

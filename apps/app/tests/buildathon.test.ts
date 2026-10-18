import { describe, expect, test } from "bun:test";

import {
  announcementsToNotify,
  promoActive,
  readAnnouncementIds,
  readPromoIds,
  rememberAnnouncementIds,
  rememberPromoId,
  unreadAnnouncementIds,
  type BuildathonAnnouncement,
  type BuildathonPromo,
  buildathonChipText,
  buildathonCountdown,
  buildathonProjectPaths,
  buildathonProjects,
  buildathonServerBody,
  projectAnswered,
  readProjectEntries,
  resetBuildathonServerSync,
  syncBuildathonServer,
  clockOffsetMs,
  formatEventTime,
  formatRemaining,
  projectKey,
  readProjectTrack,
  readShownReminders,
  readTaggedSessions,
  refreshBuildathon,
  rememberShownReminders,
  rememberTaggedSession,
  reminderToShow,
  rulesWithToolRuleFirst,
  sessionsToTag,
  useBuildathonStore,
  writeProjectTrack,
  type BuildathonEvent,
  type BuildathonStatus,
} from "../src/app/lib/buildathon";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const EVENT: BuildathonEvent = {
  id: "frontier-2026",
  name: "Mars Frontier Buildathon 2026",
  startsAt: "2026-10-13T18:30:00Z",
  registrationEndsAt: "2026-10-19T18:29:59Z",
  deadlineAt: "2026-10-20T18:29:59Z",
  resultsAt: "2026-10-25T06:30:00Z",
  phase: "building",
  pageUrl: "https://unstop.com/p/x",
  submitUrl: "https://marsai.click/console/buildathon",
  rules: ["Individual only.", "Mars must be the only generative AI tool you use."],
  tracks: [{ id: "agents", label: "Agents & Automation" }, { id: "devtools", label: "Developer Tools & Open Source" }],
  reminders: [
    { beforeSeconds: 86_400, text: "24 hours left" },
    { beforeSeconds: 3_600, text: "1 hour left" },
    { beforeSeconds: 900, text: "15 minutes left" },
  ],
};
const DEADLINE = Date.parse(EVENT.deadlineAt);
const HOUR = 3_600_000;

describe("countdown", () => {
  test("formats days, hours, minutes", () => {
    expect(formatRemaining(5 * 24 * HOUR + 3 * HOUR + 20 * 60_000)).toBe("5d 03h");
    expect(formatRemaining(4 * HOUR + 7 * 60_000)).toBe("4h 07m");
    expect(formatRemaining(42 * 60_000 + 9_000)).toBe("42m 09s");
    expect(formatRemaining(-5)).toBe("0m 00s");
  });

  test("open, red under an hour, closed after the deadline or once judging", () => {
    const open = buildathonCountdown(EVENT, DEADLINE - (5 * 24 + 3) * HOUR);
    expect(open.kind).toBe("open");
    expect(open.urgent).toBe(false);
    expect(buildathonChipText(open)).toBe("Buildathon · 5d 03h left");

    const last = buildathonCountdown(EVENT, DEADLINE - 30 * 60_000);
    expect(last.urgent).toBe(true);
    expect(buildathonChipText(last)).toBe("Buildathon · 30m 00s left");

    const closed = buildathonCountdown(EVENT, DEADLINE + 1);
    expect(closed.kind).toBe("closed");
    expect(buildathonChipText(closed)).toBe("Buildathon · Submissions closed");
    expect(buildathonCountdown({ ...EVENT, phase: "judging" }, DEADLINE - HOUR * 10).kind).toBe("closed");
  });

  test("before the start it counts to the start", () => {
    const upcoming = buildathonCountdown(EVENT, Date.parse(EVENT.startsAt!) - 2 * HOUR);
    expect(upcoming.kind).toBe("upcoming");
    expect(buildathonChipText(upcoming)).toBe("Buildathon · starts in 2h 00m");
  });

  test("the server clock offset", () => {
    expect(clockOffsetMs("2026-10-15T10:00:10Z", Date.parse("2026-10-15T10:00:00Z"))).toBe(10_000);
    expect(clockOffsetMs(null, 5)).toBe(0);
  });

  test("event times are shown in IST", () => {
    expect(formatEventTime(EVENT.deadlineAt)).toContain("20 Oct, 23:59 IST");
    expect(formatEventTime(null)).toBe("");
  });
});

describe("reminders", () => {
  test("each once, the tightest due one only", () => {
    const storage = memoryStorage();
    const at = (ms: number) => reminderToShow(EVENT, buildathonCountdown(EVENT, DEADLINE - ms), readShownReminders(storage));
    expect(at(30 * HOUR)).toBeNull();
    const day = at(20 * HOUR)!;
    expect(day.text).toBe("24 hours left");
    rememberShownReminders(day.keys, storage);
    expect(at(19 * HOUR)).toBeNull();
    // Opening the app with ten minutes left: only the 15-minute text, and the hour is never shown after.
    const late = at(10 * 60_000)!;
    expect(late.text).toBe("15 minutes left");
    rememberShownReminders(late.keys, storage);
    expect(at(5 * 60_000)).toBeNull();
    expect(reminderToShow(EVENT, buildathonCountdown(EVENT, DEADLINE + 1), new Set())).toBeNull();
  });
});

describe("project tracks and tagging", () => {
  test("stored per folder, trailing separators ignored", () => {
    const storage = memoryStorage();
    writeProjectTrack("/home/a/app/", "agents", storage);
    expect(readProjectTrack("/home/a/app", storage)).toBe("agents");
    expect(readProjectTrack("/home/a/other", storage)).toBeNull();
    writeProjectTrack("/home/a/app", null, storage);
    expect(readProjectTrack("/home/a/app", storage)).toBeNull();
    expect(projectKey("  C:\\work\\x\\ ")).toBe("C:\\work\\x");
    expect(projectKey("")).toBeNull();
  });

  test("root sessions inside the event, once per track", () => {
    const inside = Date.parse("2026-10-15T00:00:00Z");
    const projects = buildathonProjects([
      {
        workspace: { id: "w1", path: "/p/app", name: "app", workspaceType: "local" },
        sessions: [
          { id: "ses_a", time: { created: inside } },
          { id: "ses_child", parentID: "ses_a", time: { created: inside } },
          { id: "ses_old", time: { created: Date.parse("2026-10-01T00:00:00Z") } },
          { id: "ses_done", time: { created: inside } },
        ],
      },
      { workspace: { id: "w2", path: "/p/remote", name: "r", workspaceType: "remote" }, sessions: [{ id: "ses_r", time: { created: inside } }] },
      { workspace: { id: "w3", path: "/p/none", name: "n", workspaceType: "local" }, sessions: [{ id: "ses_n", time: { created: inside } }] },
    ]);
    const tracks = { "/p/app": "agents", "/p/remote": "agents" };
    expect(sessionsToTag(projects, EVENT, tracks, { ses_done: "agents" })).toEqual([{ sessionId: "ses_a", track: "agents", project: "app" }]);
    // A track change re-files the project's sessions.
    expect(sessionsToTag(projects, EVENT, { "/p/app": "devtools" }, { ses_done: "agents" }).map((entry) => entry.sessionId)).toEqual(["ses_a", "ses_done"]);
    // Unknown track ids are never sent.
    expect(sessionsToTag(projects, EVENT, { "/p/app": "nope" }, {})).toEqual([]);
  });

  test("remembered tags are capped", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 510; index += 1) rememberTaggedSession(`ses_${index}`, "agents", storage);
    const tagged = readTaggedSessions(storage);
    expect(Object.keys(tagged).length).toBe(500);
    expect(tagged.ses_509).toBe("agents");
    expect(tagged.ses_0).toBeUndefined();
  });
});

test("the only-tool rule comes first", () => {
  expect(rulesWithToolRuleFirst(EVENT.rules)[0]).toContain("only generative AI tool");
  expect(rulesWithToolRuleFirst([])[0]).toContain("only generative AI tool");
});

describe("refresh", () => {
  const status: BuildathonStatus = { enrolled: true, serverTime: null, event: EVENT, participant: null, submission: null, repro: { box: "on", agentRules: "", checklist: [] }, announcements: [], github: null };

  test("enrolled shows, anything else hides", async () => {
    await refreshBuildathon(async () => status);
    expect(useBuildathonStore.getState().status?.event.id).toBe("frontier-2026");
    await refreshBuildathon(async () => null);
    expect(useBuildathonStore.getState().status).toBeNull();
    await refreshBuildathon(async () => status);
    await refreshBuildathon(async () => {
      throw new Error("bridge missing");
    });
    expect(useBuildathonStore.getState().status).toBeNull();
  });
});

describe("reproducibility mode: buildathon projects", () => {
  const inside = Date.parse("2026-10-15T00:00:00Z");
  const before = Date.parse("2026-10-01T00:00:00Z");

  test("a track, or a skip first answered inside the event; the first answer's time is kept", () => {
    const storage = memoryStorage();
    writeProjectTrack("/p/tracked", "agents", storage, before);
    writeProjectTrack("/p/skipped", null, storage, inside);
    writeProjectTrack("/p/early-skip", null, storage, before);
    writeProjectTrack("/p/unknown-track", "nope", storage, inside);
    expect(projectAnswered("/p/skipped", storage)).toBe(true);
    expect(projectAnswered("/p/never", storage)).toBe(false);
    expect(buildathonProjectPaths(EVENT, readProjectEntries(storage))).toEqual(["/p/skipped", "/p/tracked"]);
    // A later track keeps the first answer's time; a later skip of an early folder does not make it one.
    writeProjectTrack("/p/early-skip", null, storage, inside);
    expect(readProjectEntries(storage)["/p/early-skip"]!.first).toBe(new Date(before).toISOString());
    expect(buildathonProjectPaths(EVENT, readProjectEntries(storage))).not.toContain("/p/early-skip");
  });

  test("older entries (the track alone) still read", () => {
    const storage = memoryStorage({ "mars.buildathon.tracks.v1": JSON.stringify({ "/p/old": "agents" }) });
    expect(readProjectTrack("/p/old", storage)).toBe("agents");
    expect(buildathonProjectPaths(EVENT, readProjectEntries(storage))).toEqual(["/p/old"]);
  });

  test("the server's body, sent only when it changed; a failure is sent again", async () => {
    resetBuildathonServerSync();
    const status: BuildathonStatus = {
      enrolled: true, serverTime: null, event: EVENT, participant: null, submission: null,
      repro: { box: "on", agentRules: "Rules.", checklist: [] },
      announcements: [],
      github: null,
    };
    const storage = memoryStorage();
    writeProjectTrack("/p/app", "agents", storage, inside);
    const entries = readProjectEntries(storage);
    expect(buildathonServerBody(status, entries)).toEqual({ repro: { box: "on", agent_rules: "Rules." }, projects: ["/p/app"], deadline_at: EVENT.deadlineAt });
    expect(buildathonServerBody(null, entries)).toBeNull();
    const sent: unknown[] = [];
    expect(await syncBuildathonServer(status, async () => { throw new Error("down"); }, entries)).toBe("failed");
    expect(await syncBuildathonServer(status, async (body) => void sent.push(body), entries)).toBe("sent");
    expect(await syncBuildathonServer(status, async (body) => void sent.push(body), entries)).toBe("unchanged");
    expect(await syncBuildathonServer(null, async (body) => void sent.push(body), entries)).toBe("skipped");
    expect(sent.length).toBe(1);
  });
});

describe("promo (non-participants)", () => {
  const promo: BuildathonPromo = {
    id: "frontier-2026-reg", title: "Frontier Buildathon 2026", text: "$300 prize pool", ctaLabel: "Join the Buildathon",
    ctaUrl: "https://marsai.click/buildathon", endsAt: "2026-10-19T18:29:59Z", join: false, joinUrl: null,
  };
  const before = Date.parse("2026-10-15T00:00:00Z");

  test("on until dismissed under its id, and never after its end", () => {
    const storage = memoryStorage();
    expect(promoActive(promo, before, readPromoIds("dismissed", storage))).toBe(true);
    expect(promoActive(promo, Date.parse("2026-10-19T18:30:00Z"), new Set())).toBe(false);
    expect(promoActive({ ...promo, endsAt: null }, Date.parse("2027-01-01T00:00:00Z"), new Set())).toBe(true);
    expect(promoActive(null, before, new Set())).toBe(false);
    rememberPromoId("dismissed", promo.id, storage);
    expect(promoActive(promo, before, readPromoIds("dismissed", storage))).toBe(false);
    // A new id shows again.
    expect(promoActive({ ...promo, id: "frontier-2026-last-call" }, before, readPromoIds("dismissed", storage))).toBe(true);
    expect(readPromoIds("card", storage).size).toBe(0);
  });

  test("the store takes a promo or a status, never both", async () => {
    const status: BuildathonStatus = { enrolled: true, serverTime: null, event: EVENT, participant: null, submission: null, repro: { box: "on", agentRules: "", checklist: [] }, announcements: [], github: null };
    await refreshBuildathon(async () => ({ enrolled: false, serverTime: null, promo }));
    expect(useBuildathonStore.getState().promo?.id).toBe(promo.id);
    expect(useBuildathonStore.getState().status).toBeNull();
    // Joining on the web: the watch re-reads; the first enrolled answer replaces the promo at once.
    useBuildathonStore.getState().startJoinWatch(1_000);
    expect(useBuildathonStore.getState().joinWatchUntil).toBe(1_000 + 10 * 60_000);
    await refreshBuildathon(async () => status);
    expect(useBuildathonStore.getState().promo).toBeNull();
    expect(useBuildathonStore.getState().status?.event.id).toBe("frontier-2026");
    expect(useBuildathonStore.getState().joinedAt).not.toBeNull();
    expect(useBuildathonStore.getState().joinWatchUntil).toBe(0);
    useBuildathonStore.getState().clearJoined();
    // A participant's later reads are not a new join.
    await refreshBuildathon(async () => status);
    expect(useBuildathonStore.getState().joinedAt).toBeNull();
    await refreshBuildathon(async () => ({ enrolled: false, serverTime: null, promo }));
    await refreshBuildathon(async () => null);
    expect(useBuildathonStore.getState().promo).toBeNull();
    expect(useBuildathonStore.getState().status).toBeNull();
  });
});

describe("announcements (participants)", () => {
  const item = (id: string, title = id): BuildathonAnnouncement => ({ id, title, body: "", url: null, level: "info", publishedAt: null });
  const feed = [item("a_5"), item("a_4"), item("a_3"), item("a_2"), item("a_1")]; // newest first

  test("each once; a burst shows the newest few (newest last) and counts the rest", () => {
    const storage = memoryStorage();
    const first = announcementsToNotify(feed, readAnnouncementIds("notified", storage));
    expect(first.show.map((a) => a.id)).toEqual(["a_3", "a_4", "a_5"]);
    expect(first.more).toBe(2);
    expect(first.ids.length).toBe(5);
    rememberAnnouncementIds("notified", first.ids, storage);
    expect(announcementsToNotify(feed, readAnnouncementIds("notified", storage)).ids).toEqual([]);
    const next = announcementsToNotify([item("a_6"), ...feed], readAnnouncementIds("notified", storage));
    expect(next.show.map((a) => a.id)).toEqual(["a_6"]);
    expect(next.more).toBe(0);
  });

  test("unread until read in My Buildathon; ids persist and are bounded", () => {
    const storage = memoryStorage();
    expect(unreadAnnouncementIds(feed, readAnnouncementIds("read", storage)).length).toBe(5);
    rememberAnnouncementIds("read", ["a_5", "a_4"], storage);
    expect(unreadAnnouncementIds(feed, readAnnouncementIds("read", storage))).toEqual(["a_3", "a_2", "a_1"]);
    rememberAnnouncementIds("read", Array.from({ length: 300 }, (_, index) => `x_${index}`), storage);
    expect(readAnnouncementIds("read", storage).size).toBe(200);
    expect(readAnnouncementIds("notified", storage).size).toBe(0);
  });
});

// Buildathon, renderer side. The Electron main process reads
// GET /me/buildathon (apps/desktop/electron/buildathon.mjs) and answers a
// participant's status, a non-participant's promo, or null (no promo,
// offline, any error); with null everything here renders nothing. Nothing in this file is awaited on the way to the first
// screen.

import { create } from "zustand";

import type {
  MarsBuildathonAnnouncement,
  MarsBuildathonAnswer,
  MarsBuildathonEvent,
  MarsBuildathonPromo,
  MarsBuildathonSession,
  MarsBuildathonStatus,
  MarsBuildathonTagResult,
  MarsBuildathonTrack,
} from "@mars/types/desktop-ipc";

export type BuildathonStatus = MarsBuildathonStatus;
export type BuildathonEvent = MarsBuildathonEvent;
export type BuildathonSession = MarsBuildathonSession;
export type BuildathonTrack = MarsBuildathonTrack;
export type BuildathonPromo = MarsBuildathonPromo;
export type BuildathonAnnouncement = MarsBuildathonAnnouncement;
export type BuildathonAnswer = MarsBuildathonAnswer;

export const BUILDATHON_REFRESH_MS = 10 * 60_000;
/** After the join page opens: re-read every 30 s (and on focus) for 10 minutes. */
export const JOIN_WATCH_REFRESH_MS = 30_000;
export const JOIN_WATCH_MS = 10 * 60_000;
export const ONLY_TOOL_RULE = "Mars must be the only generative AI tool you use.";
export const BUILDATHON_TRACKS_STORAGE_KEY = "mars.buildathon.tracks.v1";
export const BUILDATHON_TAGGED_STORAGE_KEY = "mars.buildathon.tagged.v1";
export const BUILDATHON_REMINDERS_STORAGE_KEY = "mars.buildathon.reminders.v1";
/** Promo ids: `dismissed` (banner closed, or the card's close), `card` (the one-time home card was shown). */
export const BUILDATHON_PROMO_STORAGE_KEY = "mars.buildathon.promo.v1";
/** Announcement ids: `notified` (toast + notification shown), `read` (seen in My Buildathon). */
export const BUILDATHON_ANNOUNCEMENTS_STORAGE_KEY = "mars.buildathon.announcements.v1";
/** At most this many announcements pop up one by one; the rest are one summary toast. */
export const ANNOUNCEMENT_TOAST_LIMIT = 3;
const MAX_IDS_REMEMBERED = 200;
const MAX_TAGGED_REMEMBERED = 500;
const HOUR_MS = 3_600_000;

// --- Countdown --------------------------------------------------------------

export type BuildathonCountdown =
  | { kind: "upcoming"; remainingMs: number; urgent: false }
  | { kind: "open"; remainingMs: number; urgent: boolean }
  | { kind: "closed"; remainingMs: 0; urgent: false };

const pad = (value: number) => String(value).padStart(2, "0");

/** "5d 03h", "4h 07m", "42m 09s" (never negative). */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${pad(hours)}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${minutes}m ${pad(seconds)}s`;
}

/** Milliseconds to add to the local clock to read the server's (0 without a server time). */
export function clockOffsetMs(serverTime: string | null | undefined, receivedAtMs: number): number {
  const server = serverTime ? Date.parse(serverTime) : Number.NaN;
  return Number.isFinite(server) ? server - receivedAtMs : 0;
}

/** Where the event stands at `nowMs` (server clock). */
export function buildathonCountdown(event: BuildathonEvent, nowMs: number): BuildathonCountdown {
  const deadline = Date.parse(event.deadlineAt);
  if (event.phase === "judging" || event.phase === "results" || event.phase === "closed" || !(deadline > nowMs)) {
    return { kind: "closed", remainingMs: 0, urgent: false };
  }
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NaN;
  if (Number.isFinite(starts) && starts > nowMs) {
    return { kind: "upcoming", remainingMs: starts - nowMs, urgent: false };
  }
  const remainingMs = deadline - nowMs;
  return { kind: "open", remainingMs, urgent: remainingMs < HOUR_MS };
}

/** The chip's words: "Buildathon · 5d 03h left". */
export function buildathonChipText(countdown: BuildathonCountdown): string {
  if (countdown.kind === "closed") return "Buildathon · Submissions closed";
  if (countdown.kind === "upcoming") return `Buildathon · starts in ${formatRemaining(countdown.remainingMs)}`;
  return `Buildathon · ${formatRemaining(countdown.remainingMs)} left`;
}

/** "20 Oct, 23:59 IST", plus the local time when the machine is not on IST. */
export function formatEventTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const ist = new Intl.DateTimeFormat(locale ?? "en-GB", { ...options, timeZone: "Asia/Kolkata" }).format(date);
  let localZone = "";
  try {
    localZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    localZone = "";
  }
  if (localZone === "Asia/Kolkata" || localZone === "Asia/Calcutta") return `${ist} IST`;
  const local = new Intl.DateTimeFormat(locale ?? "en-GB", { ...options, timeZoneName: "short" }).format(date);
  return `${ist} IST · ${local} your time`;
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.floor(value)));
}

/** The event's rules with the only-tool rule first (the server's wording when it has one). */
export function rulesWithToolRuleFirst(rules: string[]): string[] {
  const index = rules.findIndex((rule) => /only generative/i.test(rule));
  if (index < 0) return [ONLY_TOOL_RULE, ...rules];
  return [rules[index]!, ...rules.filter((_, at) => at !== index)];
}

// --- Reminders: each once --------------------------------------------------

export function reminderKey(eventId: string, beforeSeconds: number): string {
  return `${eventId}:${beforeSeconds}`;
}

/**
 * The reminder due now, once: the tightest one whose window has opened.
 * Every wider one is marked too, so opening the app with 10 minutes left
 * shows only the 15-minute text.
 */
export function reminderToShow(
  event: BuildathonEvent,
  countdown: BuildathonCountdown,
  shown: ReadonlySet<string>,
): { text: string; keys: string[] } | null {
  if (countdown.kind !== "open") return null;
  const remainingSeconds = countdown.remainingMs / 1000;
  const due = event.reminders.filter((reminder) => remainingSeconds <= reminder.beforeSeconds);
  if (!due.length) return null;
  const keys = due.map((reminder) => reminderKey(event.id, reminder.beforeSeconds));
  const tightest = due.reduce((best, reminder) => (reminder.beforeSeconds < best.beforeSeconds ? reminder : best));
  if (shown.has(reminderKey(event.id, tightest.beforeSeconds))) return null;
  return { text: tightest.text, keys };
}

// --- Local storage ---------------------------------------------------------

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T, storage: KeyValueStore | null): T {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown, storage: KeyValueStore | null): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the worst case is asking or tagging once more.
  }
}

/** The key a project folder is stored under: trimmed, without trailing separators. */
export function projectKey(path: string | null | undefined): string | null {
  const trimmed = (path ?? "").trim().replace(/[\\/]+$/, "");
  return trimmed || null;
}

/**
 * A folder's answer: its track, or null when it was skipped ("No track");
 * `first`: when it was first answered. (CLI: the folder tracks file, the same
 * fields.) Older entries were the track alone.
 */
export type ProjectEntry = { track: string | null; first: string | null; at: string | null };

export function readProjectEntries(storage: KeyValueStore | null = defaultStorage()): Record<string, ProjectEntry> {
  const value = readJson<Record<string, unknown>>(BUILDATHON_TRACKS_STORAGE_KEY, {}, storage);
  const entries: Record<string, ProjectEntry> = {};
  for (const [path, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry) entries[path] = { track: entry, first: null, at: null };
    else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const raw = entry as Record<string, unknown>;
      const iso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
      entries[path] = { track: typeof raw.track === "string" && raw.track ? raw.track : null, first: iso(raw.first), at: iso(raw.at) };
    }
  }
  return entries;
}

/** Folder -> track, for folders that have one. */
export function readProjectTracks(storage: KeyValueStore | null = defaultStorage()): Record<string, string> {
  const tracks: Record<string, string> = {};
  for (const [path, entry] of Object.entries(readProjectEntries(storage))) if (entry.track) tracks[path] = entry.track;
  return tracks;
}

export function readProjectTrack(path: string | null | undefined, storage: KeyValueStore | null = defaultStorage()): string | null {
  const key = projectKey(path);
  return key ? readProjectEntries(storage)[key]?.track ?? null : null;
}

/** Whether the folder was answered (a track or a skip). */
export function projectAnswered(path: string | null | undefined, storage: KeyValueStore | null = defaultStorage()): boolean {
  const key = projectKey(path);
  return Boolean(key && readProjectEntries(storage)[key]);
}

/** Saves a folder's track, or (null) its skip; the first answer's time is kept. */
export function writeProjectTrack(path: string | null | undefined, track: string | null, storage: KeyValueStore | null = defaultStorage(), now = Date.now()): void {
  const key = projectKey(path);
  if (!key) return;
  const entries = readProjectEntries(storage);
  const at = new Date(now).toISOString();
  entries[key] = { track, first: entries[key]?.first ?? entries[key]?.at ?? at, at };
  // A bounded list: the most recent 500 folders.
  const kept = Object.entries(entries).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at))).slice(-500);
  writeJson(BUILDATHON_TRACKS_STORAGE_KEY, Object.fromEntries(kept), storage);
}

/**
 * The buildathon projects (contract "Reproducibility mode"): folders with a
 * track, and folders skipped whose first answer fell inside the event. The
 * server leaves out generic folders (home, temp, a root).
 */
export function buildathonProjectPaths(event: BuildathonEvent, entries: Record<string, ProjectEntry>): string[] {
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NEGATIVE_INFINITY;
  const deadline = Date.parse(event.deadlineAt);
  const known = new Set(event.tracks.map((track) => track.id));
  const out: string[] = [];
  for (const [path, entry] of Object.entries(entries)) {
    if (entry.track && known.has(entry.track)) out.push(path);
    else if (!entry.track && entry.first) {
      const first = Date.parse(entry.first);
      if (first >= starts && first <= deadline) out.push(path);
    }
  }
  return out.sort();
}

/** The server's body for PUT /runtime-config/buildathon (null without an event). */
export function buildathonServerBody(status: BuildathonStatus | null, entries: Record<string, ProjectEntry>) {
  if (!status) return null;
  return {
    repro: { box: status.repro.box, agent_rules: status.repro.agentRules },
    projects: buildathonProjectPaths(status.event, entries),
    deadline_at: status.event.deadlineAt,
  };
}

export function readTaggedSessions(storage: KeyValueStore | null = defaultStorage()): Record<string, string> {
  return readJson<Record<string, string>>(BUILDATHON_TAGGED_STORAGE_KEY, {}, storage);
}

export function rememberTaggedSession(sessionId: string, track: string, storage: KeyValueStore | null = defaultStorage()): void {
  const tagged = readTaggedSessions(storage);
  delete tagged[sessionId];
  tagged[sessionId] = track;
  const ids = Object.keys(tagged);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_TAGGED_REMEMBERED))) delete tagged[id];
  writeJson(BUILDATHON_TAGGED_STORAGE_KEY, tagged, storage);
}

export function readShownReminders(storage: KeyValueStore | null = defaultStorage()): Set<string> {
  const value = readJson<unknown>(BUILDATHON_REMINDERS_STORAGE_KEY, [], storage);
  return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
}

export function rememberShownReminders(keys: string[], storage: KeyValueStore | null = defaultStorage()): void {
  const shown = readShownReminders(storage);
  for (const key of keys) shown.add(key);
  writeJson(BUILDATHON_REMINDERS_STORAGE_KEY, [...shown].slice(-50), storage);
}

// --- Promo (non-participants) -------------------------------------------------

type IdLists = Record<string, string[]>;

function readIdLists(key: string, storage: KeyValueStore | null): IdLists {
  const value = readJson<Record<string, unknown>>(key, {}, storage);
  const lists: IdLists = {};
  for (const [name, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) lists[name] = ids.filter((id): id is string => typeof id === "string");
  }
  return lists;
}

function addIds(key: string, list: string, ids: string[], storage: KeyValueStore | null): void {
  if (!ids.length) return;
  const lists = readIdLists(key, storage);
  const next = (lists[list] ?? []).filter((id) => !ids.includes(id));
  next.push(...ids);
  lists[list] = next.slice(-MAX_IDS_REMEMBERED);
  writeJson(key, lists, storage);
}

export function readPromoIds(list: "dismissed" | "card", storage: KeyValueStore | null = defaultStorage()): Set<string> {
  return new Set(readIdLists(BUILDATHON_PROMO_STORAGE_KEY, storage)[list] ?? []);
}

export function rememberPromoId(list: "dismissed" | "card", id: string, storage: KeyValueStore | null = defaultStorage()): void {
  addIds(BUILDATHON_PROMO_STORAGE_KEY, list, [id], storage);
}

/** Whether the promo is still on: not dismissed under its id and before its end (server clock). */
export function promoActive(promo: BuildathonPromo | null, nowMs: number, dismissed: ReadonlySet<string>): promo is BuildathonPromo {
  if (!promo || dismissed.has(promo.id)) return false;
  const ends = promo.endsAt ? Date.parse(promo.endsAt) : Number.NaN;
  return !(Number.isFinite(ends) && ends <= nowMs);
}

// --- Announcements (participants) ----------------------------------------------

export function readAnnouncementIds(list: "notified" | "read", storage: KeyValueStore | null = defaultStorage()): Set<string> {
  return new Set(readIdLists(BUILDATHON_ANNOUNCEMENTS_STORAGE_KEY, storage)[list] ?? []);
}

export function rememberAnnouncementIds(list: "notified" | "read", ids: string[], storage: KeyValueStore | null = defaultStorage()): void {
  addIds(BUILDATHON_ANNOUNCEMENTS_STORAGE_KEY, list, ids, storage);
}

/**
 * The announcements to pop up now: those never shown, oldest first so the
 * newest ends on top. Past the limit only the newest pop up and the rest are
 * counted (one summary).
 */
export function announcementsToNotify(
  announcements: BuildathonAnnouncement[],
  notified: ReadonlySet<string>,
  limit = ANNOUNCEMENT_TOAST_LIMIT,
): { show: BuildathonAnnouncement[]; more: number; ids: string[] } {
  const fresh = announcements.filter((announcement) => !notified.has(announcement.id));
  const show = fresh.slice(0, limit).reverse();
  return { show, more: Math.max(0, fresh.length - limit), ids: fresh.map((announcement) => announcement.id) };
}

export function unreadAnnouncementIds(announcements: BuildathonAnnouncement[], read: ReadonlySet<string>): string[] {
  return announcements.filter((announcement) => !read.has(announcement.id)).map((announcement) => announcement.id);
}

// --- Which sessions to tag ---------------------------------------------------

export type BuildathonProject = {
  id: string;
  path: string;
  name: string;
  local: boolean;
  sessions: Array<{ id: string; created: number | null; parentId: string | null }>;
};

/**
 * Root sessions of a project with a track, started inside the event, whose
 * track the server has not been told yet (or was told a different one).
 */
export function sessionsToTag(
  projects: BuildathonProject[],
  event: BuildathonEvent,
  tracks: Record<string, string>,
  tagged: Record<string, string>,
  limit = 20,
): Array<{ sessionId: string; track: string; project: string | null }> {
  const starts = event.startsAt ? Date.parse(event.startsAt) : Number.NEGATIVE_INFINITY;
  const deadline = Date.parse(event.deadlineAt);
  const known = new Set(event.tracks.map((track) => track.id));
  const out: Array<{ sessionId: string; track: string; project: string | null }> = [];
  for (const project of projects) {
    if (!project.local) continue;
    const key = projectKey(project.path);
    const track = key ? tracks[key] : undefined;
    if (!track || !known.has(track)) continue;
    for (const session of project.sessions) {
      if (session.parentId || tagged[session.id] === track) continue;
      const created = session.created ?? Number.NaN;
      if (!Number.isFinite(created) || created < starts || created > deadline) continue;
      out.push({ sessionId: session.id, track, project: key!.split(/[\\/]/).pop() || null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// --- Store -------------------------------------------------------------------

type BuildathonStore = {
  status: BuildathonStatus | null;
  /** A non-participant's promo (null for participants and when there is none). */
  promo: BuildathonPromo | null;
  /** Bumped when a promo is dismissed or an announcement read, so views re-read storage. */
  seenVersion: number;
  /** Until when (local ms) the app re-reads often, after opening the join page. */
  joinWatchUntil: number;
  /** Set when this run saw the account go from the promo to enrolled (the "You're in" moment). */
  joinedAt: number | null;
  /** Server clock minus local clock, from the latest answer. */
  offsetMs: number;
  panelOpen: boolean;
  projects: BuildathonProject[];
  /** The project open in the app (the panel's checklist is about it). */
  selectedProjectId: string | null;
  /** Projects created in this run, waiting for the one-time track question. */
  newProjects: Array<{ path: string; name: string }>;
  /** Bumped on every track change so pickers re-read storage. */
  tracksVersion: number;
  setStatus: (status: BuildathonStatus | null, receivedAtMs?: number) => void;
  /** Either a participant's status or a promo (or neither): one answer of GET /me/buildathon. */
  setAnswer: (answer: BuildathonAnswer, receivedAtMs?: number) => void;
  bumpSeen: () => void;
  startJoinWatch: (nowMs?: number) => void;
  clearJoined: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setProjects: (projects: BuildathonProject[], selectedProjectId?: string | null) => void;
  noteNewProject: (project: { path: string; name: string }) => void;
  dropNewProject: (path: string) => void;
  bumpTracks: () => void;
};

/** Enrolled after showing the promo in this run: the join just happened (the watch ends). */
function joinedFrom(state: BuildathonStore, nowMs: number): Partial<BuildathonStore> {
  return state.promo && !state.status ? { joinedAt: nowMs, joinWatchUntil: 0 } : {};
}

export const useBuildathonStore = create<BuildathonStore>((set) => ({
  status: null,
  promo: null,
  seenVersion: 0,
  joinWatchUntil: 0,
  joinedAt: null,
  offsetMs: 0,
  panelOpen: false,
  projects: [],
  selectedProjectId: null,
  newProjects: [],
  tracksVersion: 0,
  setStatus: (status, receivedAtMs = Date.now()) =>
    set((state) => ({
      status,
      offsetMs: status ? clockOffsetMs(status.serverTime, receivedAtMs) : 0,
      promo: status ? null : state.promo,
      panelOpen: status ? state.panelOpen : false,
      ...(status ? joinedFrom(state, receivedAtMs) : {}),
    })),
  setAnswer: (answer, receivedAtMs = Date.now()) =>
    set((state) => {
      if (answer?.enrolled === true) {
        return { status: answer, promo: null, offsetMs: clockOffsetMs(answer.serverTime, receivedAtMs), panelOpen: state.panelOpen, ...joinedFrom(state, receivedAtMs) };
      }
      if (answer?.enrolled === false && answer.promo) {
        return { status: null, promo: answer.promo, offsetMs: clockOffsetMs(answer.serverTime, receivedAtMs), panelOpen: false };
      }
      return { status: null, promo: null, offsetMs: 0, panelOpen: false };
    }),
  bumpSeen: () => set((state) => ({ seenVersion: state.seenVersion + 1 })),
  startJoinWatch: (nowMs = Date.now()) => set({ joinWatchUntil: nowMs + JOIN_WATCH_MS }),
  clearJoined: () => set({ joinedAt: null }),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  setProjects: (projects, selectedProjectId = null) => set({ projects, selectedProjectId }),
  noteNewProject: (project) =>
    set((state) => {
      const key = projectKey(project.path);
      if (!key || state.newProjects.some((entry) => projectKey(entry.path) === key)) return state;
      return { newProjects: [...state.newProjects, { path: key, name: project.name }] };
    }),
  dropNewProject: (path) =>
    set((state) => ({ newProjects: state.newProjects.filter((entry) => entry.path !== projectKey(path)) })),
  bumpTracks: () => set((state) => ({ tracksVersion: state.tracksVersion + 1 })),
}));

/** A project folder was just created (desktop); the event layer may ask for its track once. */
export function noteNewBuildathonProject(path: string | null | undefined, name?: string | null): void {
  const key = projectKey(path);
  if (!key) return;
  useBuildathonStore.getState().noteNewProject({ path: key, name: name?.trim() || key.split(/[\\/]/).pop() || key });
}

let refreshing: Promise<void> | null = null;

/** One read of the event (a participant's status or a promo); any failure hides everything. Never throws. */
export function refreshBuildathon(read: () => Promise<BuildathonAnswer>): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      useBuildathonStore.getState().setAnswer(await read());
    } catch {
      useBuildathonStore.getState().setAnswer(null);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Saves a folder's track and tells the server about its event sessions on the next pass. */
export function setProjectTrack(path: string | null | undefined, track: string | null): void {
  writeProjectTrack(path, track);
  useBuildathonStore.getState().bumpTracks();
}

/**
 * Tells the server the track of every session that needs it, one at a time
 * and fire-and-forget: a refusal is final, a failure is tried on a later pass.
 */
export async function tagSessions(
  pending: Array<{ sessionId: string; track: string; project?: string | null }>,
  tag: (input: { sessionId: string; track: string; project?: string | null }) => Promise<MarsBuildathonTagResult>,
): Promise<void> {
  for (const entry of pending) {
    let result: MarsBuildathonTagResult = "retry";
    try {
      result = await tag(entry);
    } catch {
      result = "retry";
    }
    if (result !== "retry") rememberTaggedSession(entry.sessionId, entry.track);
  }
}

export function sessionStatusLabel(status: BuildathonSession["status"]): string {
  if (status === "good") return "Counts";
  if (status === "incomplete") return "Incomplete";
  return "Pending";
}


type SessionGroupLike = {
  workspace: { id: string; path: string; name?: string | null; displayName?: string | null; workspaceType?: string | null };
  sessions: Array<{ id: string; parentID?: string | null; time?: { created?: number | null } | null }>;
};

/** The sidebar's groups as the layer needs them (local folders, root sessions, start times). */
export function buildathonProjects(groups: SessionGroupLike[]): BuildathonProject[] {
  return groups.map((group) => ({
    id: group.workspace.id,
    path: group.workspace.path,
    name: group.workspace.displayName?.trim() || group.workspace.name?.trim() || group.workspace.path,
    local: group.workspace.workspaceType === "local",
    sessions: group.sessions.map((session) => ({
      id: session.id,
      created: typeof session.time?.created === "number" ? session.time.created : null,
      parentId: session.parentID ?? null,
    })),
  }));
}

let lastSent: string | null = null;

/**
 * Tells the local server the buildathon projects and the event's `repro`
 * block when they changed since the last answer it took. Never throws; a
 * failure is tried again on the next call.
 */
export async function syncBuildathonServer(
  status: BuildathonStatus | null,
  send: (body: NonNullable<ReturnType<typeof buildathonServerBody>>) => Promise<unknown>,
  entries: Record<string, ProjectEntry> = readProjectEntries(),
): Promise<"sent" | "unchanged" | "skipped" | "failed"> {
  const body = buildathonServerBody(status, entries);
  if (!body) return "skipped";
  const key = JSON.stringify(body);
  if (key === lastSent) return "unchanged";
  try {
    await send(body);
    lastSent = key;
    return "sent";
  } catch {
    return "failed";
  }
}

export function resetBuildathonServerSync(): void {
  lastSent = null;
}

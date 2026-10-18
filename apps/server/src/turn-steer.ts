/**
 * Steering: a prompt the user sends while the agent is still working.
 *
 * The engine takes such a prompt at once and hands it to the model at the
 * agent's next step (after the tool or sub-agent that is running), inside the
 * running turn. Nothing here holds or refuses a prompt: `classify` only tells
 * the capture whether the prompt opens a new turn (a start snapshot, a new
 * baseline) or steers the running one (no snapshot: the turn keeps the
 * workspace its first prompt found), and `describe` finds the engine's record
 * of the steer afterwards for the trace's `turn.steer` event.
 *
 * Reads are small and bounded: the status map, then at most a few of the
 * newest messages of one session. Any failure answers "not a steer", so the
 * prompt is captured as a turn of its own, as before steering existed.
 *
 * The same rules as mars-cli's src/turn-steer.js (docs/turns-and-steering.md there).
 */
import { loopbackFetch } from "./server-fetch.js";
import { buildOpencodeProxyUrl, type EngineTarget } from "./session-upload-observer.js";

const NORMAL_FINISH = new Set(["stop", "end_turn", "end-turn", "stop_sequence", "length"]);
const STATUS_MAX_BYTES = 1024 * 1024;
const MESSAGES_MAX_BYTES = 16 * 1024 * 1024;

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const infoOf = (message: unknown): unknown => (isRecord(message) && isRecord(message.info) ? message.info : message);
const toMs = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Why a prompt counted as it did: a steer (`working`, `busy_unread`) or a turn start (the rest). */
export type SteerReason = "idle" | "working" | "busy_unread" | "not_started" | "ending" | "compacting" | "status_unreadable";
export type SteerVerdict = { steer: boolean; busy: boolean | null; reason: SteerReason; error?: string };

/** A tool call relative to a steer: `sub_agent` is the task tool's child session. */
export type SteerToolCall = { tool: string | null; call_id: string | null; started_at: string; ended_at?: string; sub_agent?: string };
export type SteerFound = { message_id: string; created_at: string; running: SteerToolCall[]; after_call: SteerToolCall | null };

function isPrompt(message: unknown): boolean {
  const info = infoOf(message);
  if (!isRecord(info) || info.role !== "user" || info.agent === "compaction") return false;
  const parts = (isRecord(message) && Array.isArray(message.parts) ? message.parts : []).filter(isRecord);
  if (parts.some((part) => part.type === "compaction")) return false;
  const content = parts.filter((part) => ["text", "file", "agent", "subtask"].includes(String(part.type)));
  return !(content.length > 0 && content.every((part) => part.type === "text" && part.synthetic === true));
}

/** A compaction's summary (the engine compacting the chat): no agent step, a prompt sent then opens a turn. */
export function compactionSummary(message: unknown): boolean {
  const info = infoOf(message);
  return isRecord(info) && info.role === "assistant" && (info.summary === true || info.mode === "compaction" || info.agent === "compaction");
}

/** Whether the agent is mid-turn on `newest` (the session's newest message): an assistant step that has not ended normally. */
export function workingOn(newest: unknown): boolean {
  const info = infoOf(newest);
  if (!isRecord(info) || info.role !== "assistant") return false;
  if (info.error != null || compactionSummary(newest)) return false;
  const completed = toMs(isRecord(info.time) ? info.time.completed : undefined);
  return !(completed !== null && typeof info.finish === "string" && NORMAL_FINISH.has(info.finish));
}

/** The tool calls of `messages` relative to `at`: the ones running then and the last one started by then. */
export function toolsAround(messages: readonly unknown[], at: number): { running: SteerToolCall[]; last: SteerToolCall | null } {
  const running: SteerToolCall[] = [];
  let last: SteerToolCall | null = null;
  let lastStart = -Infinity;
  for (const message of messages) {
    const info = infoOf(message);
    if (!isRecord(info) || info.role !== "assistant") continue;
    for (const part of isRecord(message) && Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part) || part.type !== "tool") continue;
      const state = isRecord(part.state) ? part.state : {};
      const time = isRecord(state.time) ? state.time : {};
      const start = toMs(time.start);
      if (start === null || start > at) continue;
      const end = toMs(time.end);
      const call: SteerToolCall = {
        tool: typeof part.tool === "string" ? part.tool : null,
        call_id: typeof part.callID === "string" ? part.callID : null,
        started_at: new Date(start).toISOString(),
        ...(end !== null ? { ended_at: new Date(end).toISOString() } : {}),
      };
      const child = isRecord(state.metadata) ? state.metadata.sessionId : undefined;
      if (typeof child === "string") call.sub_agent = child;
      if (start >= lastStart) { last = call; lastStart = start; }
      if (end === null || end > at) running.push(call);
    }
  }
  return { running, last };
}

async function readBounded(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export type SteerTrackerOptions = {
  /** Bounds each read. */
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** The waits before each attempt to find a steer's record. */
  delays?: readonly number[];
};

/** The v1 engine `target` (its base URL, auth header and directory scope): which prompts steer, and the record of each steer. */
export function createSteerTracker(target: EngineTarget, { timeoutMs = 1_500, fetchImpl = loopbackFetch, delays = [150, 400, 1_000, 2_500, 5_000] }: SteerTrackerOptions = {}) {
  const read = async (route: string, query: Record<string, string>, limit: number): Promise<unknown> => {
    const url = new URL(buildOpencodeProxyUrl(target.baseUrl, route, target.search));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchImpl(url.toString(), { headers: new Headers(target.headers), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`engine answered ${response.status}`);
    }
    return readBounded(response, limit);
  };
  const newest = async (sessionId: string, count: number): Promise<unknown[]> => {
    const list = await read(`/session/${encodeURIComponent(sessionId)}/message`, { limit: String(count) }, MESSAGES_MAX_BYTES);
    if (!Array.isArray(list)) throw new Error("unreadable message list");
    return list;
  };

  return {
    /**
     * Whether a prompt to `sessionId`, about to be forwarded, steers a running
     * turn: the engine says the session is busy and its newest message is an
     * assistant step still at work. A session busy with nothing answered yet
     * (the prompt before was just sent) gets the two prompts answered together
     * by the engine: that is a turn of its own, as the converter counts it.
     */
    async classify(sessionId: string): Promise<SteerVerdict> {
      let statuses: unknown;
      try { statuses = await read("/session/status", {}, STATUS_MAX_BYTES); }
      catch (error) { return { steer: false, busy: null, reason: "status_unreadable", error: errorText(error) }; }
      const entry = isRecord(statuses) ? statuses[sessionId] : undefined;
      const type = isRecord(entry) ? entry.type : "idle";
      if (type !== "busy" && type !== "retry") return { steer: false, busy: false, reason: "idle" };
      try {
        const [last] = (await newest(sessionId, 1)).slice(-1);
        if (workingOn(last)) return { steer: true, busy: true, reason: "working" };
        if (compactionSummary(last)) return { steer: false, busy: true, reason: "compacting" };
        const info = infoOf(last);
        return { steer: false, busy: true, reason: isRecord(info) && info.role === "user" ? "not_started" : "ending" };
      } catch (error) {
        // Busy, newest unknown: the engine delivers the prompt into the running turn.
        return { steer: true, busy: true, reason: "busy_unread", error: errorText(error) };
      }
    },

    /**
     * The engine's record of a steer sent at `sentAt`: its message id and
     * creation time, the tool calls running when it arrived and the last one
     * started before it. Null when it cannot be found in time.
     */
    async describe(sessionId: string, sentAt: number, { known = new Set<string>(), stopped = () => false }: { known?: ReadonlySet<string>; stopped?: () => boolean } = {}): Promise<SteerFound | null> {
      for (const delay of delays) {
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, delay); timer.unref?.(); });
        if (stopped()) return null;
        let list: unknown[];
        try { list = await newest(sessionId, 6); } catch { continue; }
        // The first prompt the engine created since it was sent (the engine creates it on receipt).
        const steer = list.find((message) => {
          const info = infoOf(message);
          if (!isRecord(info)) return false;
          const created = toMs(isRecord(info.time) ? info.time.created : undefined);
          return isPrompt(message) && typeof info.id === "string" && !known.has(info.id) && created !== null && created >= sentAt - 50;
        });
        if (!steer) continue;
        const info = infoOf(steer) as Json;
        const created = toMs((info.time as Json).created) as number;
        const before = list.filter((message) => {
          const at = (() => { const i = infoOf(message); return isRecord(i) && isRecord(i.time) ? toMs(i.time.created) : null; })();
          return at !== null && at <= created;
        });
        const { running, last } = toolsAround(before, created);
        return { message_id: info.id as string, created_at: new Date(created).toISOString(), running, after_call: last };
      }
      return null;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The steer messages already claimed per session (a later steer's record never names an earlier one's message). */
const MAX_STEER_SESSIONS = 256;
const MAX_STEERS_PER_SESSION = 64;
const claimedSteers = new Map<string, Set<string>>();

export function claimedSteerIds(sessionId: string): Set<string> {
  let known = claimedSteers.get(sessionId);
  if (known) {
    claimedSteers.delete(sessionId);
  } else {
    known = new Set();
  }
  claimedSteers.set(sessionId, known);
  while (claimedSteers.size > MAX_STEER_SESSIONS) claimedSteers.delete(claimedSteers.keys().next().value as string);
  return known;
}

export function claimSteerId(known: Set<string>, id: string): void {
  known.add(id);
  while (known.size > MAX_STEERS_PER_SESSION) known.delete(known.values().next().value as string);
}

/**
 * The `turn.steer` record (schema 1, without `turn_started_at`, which the
 * session uploader adds): `found` from describe(), null when it was not found in time.
 */
export function steerRecord(found: SteerFound | null, sentAt: number, reason: SteerReason): Record<string, unknown> {
  return {
    message_id: found?.message_id ?? null,
    sent_at: new Date(sentAt).toISOString(),
    ...(found ? { created_at: found.created_at, running: found.running, after_call: found.after_call } : {}),
    delivery: "next_step",
    classified: reason,
  };
}

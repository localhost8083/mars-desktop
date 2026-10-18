/**
 * Which user messages of an engine session open a turn. The same file ships
 * in mars-cli and mars-gui (PARITY.sha256): every turn number the
 * clients write (archive states, context turns, a resumed session's count)
 * comes from here, so both number turns the same way.
 *
 * A turn is a prompt someone sent and everything the agent did for it. Two
 * kinds of user message do not open one:
 *
 * - the engine's own: a compaction's request, synthetic text alone (a
 *   user-run shell command's notice, an activated skill, a background job's
 *   report, the continue nudge);
 * - a steer: a prompt sent while the agent was still working on the turn
 *   before. The engine delivers it at the agent's next step, inside the
 *   running turn, so the turn keeps the workspace its first prompt found and
 *   the steer is recorded in it (the client's `turn.steer` event).
 *
 * A prompt is a steer when an assistant message (not a compaction's
 * summary) created before it ended after it was sent (the agent was mid-step: thinking, a tool, a sub-agent),
 * or when the step before it asked for more steps (tool calls) and ended at
 * most STEER_GAP_MS before it, without an error (between two steps). An
 * assistant message that never ended (a crashed run) proves nothing.
 */
export const STEER_GAP_MS = 2_000;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function infoOf(message: MessageRecord): MessageRecord {
  return isRecord(message.info) ? message.info : message;
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createdMs(message: MessageRecord): number | null {
  const info = infoOf(message);
  return timeMs(isRecord(info.time) ? info.time.created : info.createdAt ?? info.created_at);
}

function completedMs(message: MessageRecord): number | null {
  const info = infoOf(message);
  return timeMs(isRecord(info.time) ? info.time.completed : info.completedAt ?? info.completed_at);
}

function roleOf(message: MessageRecord): unknown {
  const info = infoOf(message);
  return info.role ?? info.type;
}

/**
 * An assistant message that is a compaction's summary: the engine at work
 * on the chat, not the agent on a turn. A prompt sent while it runs (an
 * automatic or a /compact compaction) opens a turn of its own.
 */
function isCompactionSummary(message: MessageRecord): boolean {
  const info = infoOf(message);
  return info.summary === true || info.mode === "compaction" || info.agent === "compaction";
}

/**
 * A user message that is a prompt someone sent: not a compaction's request
 * (a "compaction" part, or the 2.x adapter's compaction agent) and not
 * synthetic text alone. A message without parts (an outline from before
 * parts were kept) is one.
 */
export function isPromptMessage(message: MessageRecord): boolean {
  const info = infoOf(message);
  if ((info.role ?? info.type) !== "user") return false;
  if (info.agent === "compaction") return false;
  const parts = (Array.isArray(message.parts) ? message.parts : Array.isArray(info.content) ? info.content : []).filter(isRecord);
  if (parts.some((part) => part.type === "compaction")) return false;
  const content = parts.filter((part) => part.type === "text" || part.type === "file" || part.type === "agent" || part.type === "subtask");
  return !(content.length > 0 && content.every((part) => part.type === "text" && part.synthetic === true));
}

/**
 * The ids (or, for a message without an id, the positions) of the prompts in
 * `messages` that steered a running turn. `messages`: one session's
 * messages in the engine's order.
 */
export function steerPrompts(messages: readonly unknown[]): Set<string | number> {
  const steers = new Set<string | number>();
  let opened = false;
  // The latest end of an assistant message so far, and the step that ended last.
  let busyUntil = -Infinity;
  let lastStep: { completed: number | null; continues: boolean } | null = null;
  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    const role = roleOf(message);
    if (role === "assistant") {
      if (isCompactionSummary(message)) return;
      const info = infoOf(message);
      const completed = completedMs(message);
      if (completed !== null) busyUntil = Math.max(busyUntil, completed);
      lastStep = { completed, continues: info.error == null && (info.finish === "tool-calls" || info.finish === "unknown") };
      return;
    }
    if (!isPromptMessage(message)) return;
    const sent = createdMs(message);
    const step = lastStep as { completed: number | null; continues: boolean } | null;
    const steer = opened && sent !== null && (
      busyUntil > sent ||
      (step !== null && step.continues && step.completed !== null && sent - step.completed <= STEER_GAP_MS)
    );
    if (steer) {
      const id = infoOf(message).id;
      steers.add(typeof id === "string" ? id : index);
    }
    opened = true;
  });
  return steers;
}

/** Whether the message at `index` of `messages` opens a turn (a prompt, not a steer). */
function opensTurn(message: MessageRecord, index: number, steers: Set<string | number>): boolean {
  if (!isPromptMessage(message)) return false;
  const id = infoOf(message).id;
  return !steers.has(typeof id === "string" ? id : index);
}

/**
 * Completed turns in an engine message list: the turns that ended, answered
 * by an assistant message that ended (several assistant steps of one turn,
 * and the steps after its steers, count once) or followed by the next prompt
 * (stopped before any answer). Each completed turn adds one, so the number
 * strictly increases from one turn to the next and survives app restarts.
 * Null when the list could not be read.
 */
export function completedTurnCount(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  const steers = steerPrompts(messages);
  let turns = 0;
  let awaitingReply = false;
  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    if (opensTurn(message, index, steers)) {
      // The prompt before ended without an answer (stopped right away): it was a turn too.
      if (awaitingReply) turns += 1;
      awaitingReply = true;
    } else if (roleOf(message) === "assistant" && awaitingReply && !isCompactionSummary(message) && isEnded(message)) {
      turns += 1;
      awaitingReply = false;
    }
  });
  return turns;
}

function isEnded(message: MessageRecord): boolean {
  const info = infoOf(message);
  if (completedMs(message) !== null) return true;
  if (typeof info.finish === "string" || info.error != null) return true;
  const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(info.content) ? info.content : [];
  return parts.some((part) => isRecord(part) && ["step-finish", "finish", "error"].includes(String(part.type)));
}

/**
 * The turn a tool call that started at `at` belongs to: the number of turns
 * opened up to then (the first prompt is turn 1), counting a prompt without
 * a creation time as sent. A steer is no turn of its own: its tool calls
 * belong to the turn it steered. Null when the list could not be read or
 * holds no prompt.
 */
export function promptTurnAt(messages: unknown, at: number): number | null {
  if (!Array.isArray(messages)) return null;
  const steers = steerPrompts(messages);
  let turns = 0;
  messages.forEach((message, index) => {
    if (!isRecord(message) || !opensTurn(message, index, steers)) return;
    const created = createdMs(message);
    if (created === null || created <= at) turns += 1;
  });
  return turns > 0 ? turns : null;
}

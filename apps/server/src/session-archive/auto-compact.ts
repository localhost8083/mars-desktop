/**
 * Automatic compaction: a chat that has had `after_turns` prompts since its
 * last compaction is compacted by the engine (its own /summarize, the same
 * compaction a person gets from /compact) before the next prompt goes out.
 * The same file ships in mars-cli and mars-gui (PARITY.sha256).
 *
 * The server decides: GET /collect/capabilities `auto_compact`
 * ({enabled, after_turns, min_context_tokens}). No block, or enabled false,
 * and nothing happens. The policy is read again right before a compaction,
 * so switching it off on the server stops the next one.
 *
 * Counting: per chat, the prompts sent since its last compaction. The first
 * prompt of a chat in this app run reads the chat once to start the count;
 * later prompts only add one. The count is an upper bound (a compaction the
 * person or the engine ran in between resets it only on the next read): a
 * compaction is decided on the chat's messages read again at that point.
 *
 * Never mid-turn: only a chat the engine reports idle is compacted, and the
 * caller asks only for a prompt that opens a turn (not a steer). Sub-agent
 * chats are never compacted on their own. A failed compaction is tried
 * again RETRY_AFTER_TURNS prompts later; the prompt goes out regardless.
 * One the person stopped (Esc) is tried again only after a full
 * `after_turns`.
 *
 * A compaction that ended without a summary (stopped, failed, timed out)
 * leaves its request in the chat, and the engine would run that request
 * again with the next prompt, answering the prompt with a summary instead.
 * Its request and broken summary are removed before the prompt goes out.
 *
 * The prompt waits for the compaction at most `holdMs`; past that it goes
 * out and the engine runs it right after the compaction.
 */
import { isPromptMessage, steerPrompts } from "./turn-prompts.js";

export const AUTO_COMPACT_NOTICE = "Compacting the conversation to keep it fast…";
export const AUTO_COMPACT_FAILED_NOTICE = "Could not compact the conversation. Continuing as is.";
/** A compaction that failed (or was skipped for a reason that may pass) is tried again this many prompts later. */
export const RETRY_AFTER_TURNS = 5;
/** How long the first prompt of a chat waits for the read that starts its count. */
export const SEED_WAIT_MS = 10_000;
/** The longest a compaction may run before it counts as failed (and the engine is told to stop it). */
export const COMPACTION_TIMEOUT_MS = 10 * 60_000;
/** After the person stops a compaction, how long the engine has to end it before the wait for it is given up. */
export const STOP_GRACE_MS = 5_000;

export type AutoCompactPolicy = { enabled: boolean; afterTurns: number; minContextTokens: number };
export type ModelRef = { providerID: string; modelID: string };

/** One chat's engine, as the caller reaches it. Each read resolves null (or throws) when it cannot be read. */
export type AutoCompactEngine = {
  /** The chat's messages in the engine's order. */
  messages(): Promise<unknown>;
  /** The chat's record (its parentID marks a sub-agent's chat). */
  session(): Promise<unknown>;
  /** Whether the engine is running the chat now; null when unknown. */
  busy(): Promise<boolean | null>;
  /** Runs the engine's compaction on `model`; resolves once it finished, rejects when it failed. */
  summarize(model: ModelRef, signal: AbortSignal): Promise<void>;
  /** Removes one message from the chat (a compaction's leftover request or broken summary). */
  removeMessage?(messageID: string): Promise<void>;
  /** Stops what the engine runs for the chat (a compaction past its time). */
  abort?(): Promise<void>;
};

export type AutoCompactStage = "started" | "finished" | "failed";

export type AutoCompactorOptions = {
  /** The server's policy (null: none, off). `fresh`: ask the server again rather than a cached answer. */
  policy(options: { fresh: boolean }): Promise<AutoCompactPolicy | null>;
  notify?(sessionId: string, stage: AutoCompactStage): void;
  log?(level: "info" | "warn", message: string, attributes?: Record<string, unknown>): void;
  /** How long a prompt waits for its chat's compaction before it goes out anyway (Infinity: until it ends). */
  holdMs?: number;
  seedWaitMs?: number;
  timeoutMs?: number;
  stopGraceMs?: number;
};

export type AutoCompactOutcome = {
  action: "none" | "compacted" | "queued" | "failed" | "skipped";
  reason?: string;
  turns?: number;
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function infoOf(message: Json): Json {
  return isRecord(message.info) ? message.info : message;
}

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** The `auto_compact` block of a /collect/capabilities answer; null when absent or unreadable (off). */
export function autoCompactPolicy(capabilities: unknown): AutoCompactPolicy | null {
  if (!isRecord(capabilities) || !isRecord(capabilities.auto_compact)) return null;
  const block = capabilities.auto_compact;
  const afterTurns = finiteInt(block.after_turns);
  if (typeof block.enabled !== "boolean" || afterTurns === null || afterTurns < 2) return null;
  const floor = finiteInt(block.min_context_tokens);
  return { enabled: block.enabled, afterTurns, minContextTokens: floor !== null && floor > 0 ? floor : 0 };
}

/** An assistant message that is a compaction's summary (the engine's compaction agent). */
export function isCompactionSummary(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const info = infoOf(message);
  if (info.role !== "assistant") return false;
  return info.summary === true || info.mode === "compaction" || info.agent === "compaction";
}

/**
 * Turns opened since the chat's last compaction (one that produced its
 * summary without an error): prompts someone sent, not steers, not the
 * engine's own messages. Null when the list could not be read.
 */
export function turnsSinceCompaction(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  const steers = steerPrompts(messages);
  let turns = 0;
  messages.forEach((message, index) => {
    if (!isRecord(message)) return;
    if (isCompactionSummary(message)) {
      if (infoOf(message).error == null) turns = 0;
      return;
    }
    if (!isPromptMessage(message)) return;
    const id = infoOf(message).id;
    if (!steers.has(typeof id === "string" ? id : index)) turns += 1;
  });
  return turns;
}

/** The context the chat's newest answered step used (input, cache and output tokens); null when none says. */
export function lastContextTokens(messages: unknown): number | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || isCompactionSummary(message)) continue;
    const info = infoOf(message);
    if (info.role !== "assistant" || !isRecord(info.tokens)) continue;
    const tokens = info.tokens;
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const total = [tokens.input, tokens.output, cache.read, cache.write]
      .reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
    if (total > 0) return total;
  }
  return null;
}

function modelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const providerID = value.providerID;
  const modelID = value.modelID ?? value.id;
  return typeof providerID === "string" && providerID && typeof modelID === "string" && modelID ? { providerID, modelID } : null;
}

/** The model a prompt body asks for (`model: {providerID, modelID}`), if it names one. */
export function promptModel(body: unknown): ModelRef | null {
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    try {
      const text = typeof body === "string" ? body : new TextDecoder().decode(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
      return promptModel(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return isRecord(body) ? modelRef(body.model) : null;
}

/** The model of the chat's newest prompt (the one the engine would go on with). */
export function lastPromptModel(messages: unknown): ModelRef | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    const info = infoOf(message);
    if (info.role !== "user") continue;
    const model = modelRef(info.model) ?? (typeof info.providerID === "string" ? modelRef({ providerID: info.providerID, modelID: info.modelID }) : null);
    if (model) return model;
  }
  return null;
}

function parentOf(session: unknown): string | null | undefined {
  if (!isRecord(session)) return undefined;
  const info = isRecord(session.info) ? session.info : session;
  const parent = info.parentID ?? info.parentId ?? info.parent_id;
  return typeof parent === "string" && parent ? parent : null;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (!Number.isFinite(ms)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idOf(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const id = infoOf(message).id;
  return typeof id === "string" && id ? id : null;
}

/** The ids of the chat's compaction summaries. */
function summaryIds(messages: unknown): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(messages)) for (const message of messages) if (isCompactionSummary(message)) { const id = idOf(message); if (id) ids.add(id); }
  return ids;
}

export type CompactionResult = {
  /** "summarized": a summary without an error; "broken": one with an error (stopped, failed); "none": no new summary. */
  state: "summarized" | "broken" | "none";
  /** The engine's error name on a broken summary (MessageAbortedError: the person stopped it). */
  error?: string;
  /** What to remove for a broken one: the summary and its compaction request. */
  leftovers: string[];
};

/**
 * How the compaction that just ran ended, from the chat's messages read
 * after it: its summary is the newest one not in `before` (the ids seen
 * before it started). `cut`: our wait for it ended early (stopped, timed
 * out, failed), so a summary the engine never closed is broken too.
 */
export function compactionResult(messages: unknown, before: Set<string>, options: { cut?: boolean } = {}): CompactionResult {
  if (!Array.isArray(messages)) return { state: "none", leftovers: [] };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isCompactionSummary(message)) continue;
    const id = idOf(message);
    if (!id || before.has(id)) return { state: "none", leftovers: [] };
    const info = infoOf(message as Json);
    const closed = isRecord(info.time) && typeof info.time.completed === "number";
    if (info.error == null && (closed || !options.cut)) return { state: "summarized", leftovers: [] };
    const error = info.error == null ? "unfinished" : isRecord(info.error) && typeof info.error.name === "string" ? info.error.name : "error";
    const leftovers = [id];
    const parentID = typeof info.parentID === "string" ? info.parentID : null;
    const request = parentID ? messages.find((entry) => idOf(entry) === parentID) : undefined;
    // Only a request that is nothing but the compaction (never a prompt someone sent).
    if (parentID && isRecord(request) && infoOf(request).role === "user") {
      const parts = Array.isArray(request.parts) ? request.parts.filter(isRecord) : [];
      if (parts.length > 0 && parts.every((part) => part.type === "compaction")) leftovers.push(parentID);
    }
    return { state: "broken", error, leftovers };
  }
  return { state: "none", leftovers: [] };
}

export class AutoCompactor {
  /** Prompts sent per chat since its last compaction (an upper bound, module docstring). */
  private readonly counts = new Map<string, number>();
  private readonly seeding = new Map<string, Promise<unknown>>();
  private readonly children = new Set<string>();
  private readonly running = new Map<string, Promise<boolean>>();
  /** The running compactions' stop handles (the person stopped the chat: give the engine STOP_GRACE_MS, then let go). */
  private readonly stops = new Map<string, () => void>();

  constructor(private readonly options: AutoCompactorOptions) {}

  /** Whether the engine is compacting `sessionId` for this compactor now. */
  compacting(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** The chat was compacted another way (the person, the engine): count from zero. */
  noteCompacted(sessionId: string): void {
    if (!this.running.has(sessionId)) this.counts.set(sessionId, 0);
  }

  /**
   * The person stopped the chat (Esc) while it compacts: the engine ends the
   * compaction, its leftovers are removed, and the held prompts go out. If
   * the engine has not answered within STOP_GRACE_MS, the wait ends anyway.
   * Returns whether a compaction was running.
   */
  stopped(sessionId: string): boolean {
    const stop = this.stops.get(sessionId);
    if (!stop) return false;
    stop();
    return true;
  }

  forget(sessionId: string): void {
    this.counts.delete(sessionId);
    this.children.delete(sessionId);
  }

  /** Prompts counted for `sessionId` since its last compaction (undefined before its first prompt). */
  count(sessionId: string): number | undefined {
    return this.counts.get(sessionId);
  }

  private log(level: "info" | "warn", message: string, attributes?: Record<string, unknown>): void {
    try { this.options.log?.(level, message, attributes); } catch { /* logging never fails a prompt */ }
  }

  private notify(sessionId: string, stage: AutoCompactStage): void {
    try { this.options.notify?.(sessionId, stage); } catch { /* a notice never fails a prompt */ }
  }

  private async policy(fresh: boolean): Promise<AutoCompactPolicy | null> {
    try { return await this.options.policy({ fresh }); } catch { return null; }
  }

  /** Starts the count of a chat seen for the first time: one read of its messages and record. Resolves the messages read. */
  private seed(sessionId: string, engine: AutoCompactEngine): Promise<unknown> {
    const pending = this.seeding.get(sessionId);
    if (pending) return pending;
    const run = (async () => {
      const [session, messages] = await Promise.all([
        engine.session().catch(() => undefined),
        engine.messages().catch(() => null),
      ]);
      if (parentOf(session)) this.children.add(sessionId);
      this.counts.set(sessionId, turnsSinceCompaction(messages) ?? 0);
      return messages;
    })().finally(() => this.seeding.delete(sessionId));
    this.seeding.set(sessionId, run);
    return run;
  }

  /** Waits (at most `ms`) until the engine runs nothing for the chat. */
  private async idle(engine: AutoCompactEngine, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await engine.busy().catch(() => null) === false) return;
      await new Promise((resolve) => { const timer = setTimeout(resolve, Math.min(250, Math.max(0, until - Date.now()))); (timer as { unref?: () => void }).unref?.(); });
    }
  }

  /** Removes a broken compaction's summary and request; resolves how many went. */
  private async removeLeftovers(engine: AutoCompactEngine, ids: string[]): Promise<number> {
    if (!engine.removeMessage || ids.length === 0) return 0;
    let removed = 0;
    for (const id of ids) {
      try { await engine.removeMessage(id); removed += 1; } catch (error) { this.log("warn", "auto compaction leftover not removed", { messageID: id, error: errorText(error) }); }
    }
    return removed;
  }

  private add(sessionId: string, base?: number): void {
    this.counts.set(sessionId, (base ?? this.counts.get(sessionId) ?? 0) + 1);
  }

  /** Try again RETRY_AFTER_TURNS prompts later; this prompt counts. */
  private later(sessionId: string, policy: AutoCompactPolicy): void {
    this.counts.set(sessionId, Math.max(0, policy.afterTurns - RETRY_AFTER_TURNS) + 1);
  }

  /**
   * Called for a prompt to `sessionId` that is about to go out and opens a
   * turn. Resolves when the prompt may go out: at once, or after the
   * chat's compaction (at most `holdMs`). `prompt`: the dispatch body (its
   * model is the compaction's).
   */
  async beforePrompt(sessionId: string, engine: AutoCompactEngine, prompt?: unknown): Promise<AutoCompactOutcome> {
    const holdMs = this.options.holdMs ?? Infinity;
    const inFlight = this.running.get(sessionId);
    if (inFlight) {
      // A prompt sent while its chat compacts goes out behind the compaction.
      this.add(sessionId);
      const done = await within(inFlight, holdMs);
      return { action: done === undefined ? "queued" : done ? "compacted" : "failed", reason: "already_compacting" };
    }
    const policy = await this.policy(false);
    // The chat's messages, when this call read them already (its first prompt).
    let read: { messages: unknown } | null = null;
    if (!this.counts.has(sessionId)) {
      // Off: no read at all. A chat is counted from its first prompt after the switch is on.
      if (!policy?.enabled) return { action: "none", reason: "off" };
      const seeded = await within(this.seed(sessionId, engine).then((messages) => ({ messages })), this.options.seedWaitMs ?? SEED_WAIT_MS);
      // Not in time: the read goes on in the background and starts the count.
      if (seeded === undefined) return { action: "none", reason: "seeding" };
      read = seeded;
    }
    if (this.children.has(sessionId)) return { action: "none", reason: "sub_agent" };
    const counted = this.counts.get(sessionId) ?? 0;
    if (!policy?.enabled || counted < policy.afterTurns) {
      this.add(sessionId);
      return { action: "none", reason: policy?.enabled ? "below" : "off", turns: counted };
    }
    // Due by the count: the server's policy now, then the chat itself.
    const current = await this.policy(true) ?? policy;
    if (!current.enabled || counted < current.afterTurns) {
      this.add(sessionId);
      return { action: "none", reason: current.enabled ? "below" : "off", turns: counted };
    }
    const busy = await engine.busy().catch(() => null);
    if (busy !== false) {
      // Mid-turn (a steer: no turn of its own) or unknown: never compact then.
      if (busy === null) this.add(sessionId);
      return { action: "skipped", reason: busy ? "busy" : "status_unreadable", turns: counted };
    }
    const messages = read ? read.messages : await engine.messages().catch(() => null);
    const turns = turnsSinceCompaction(messages);
    if (turns === null) {
      this.later(sessionId, current);
      return { action: "skipped", reason: "unreadable", turns: counted };
    }
    if (turns < current.afterTurns) {
      this.add(sessionId, turns);
      return { action: "none", reason: "below", turns };
    }
    const context = lastContextTokens(messages);
    if (current.minContextTokens > 0 && context !== null && context < current.minContextTokens) {
      this.later(sessionId, current);
      return { action: "skipped", reason: "small_context", turns };
    }
    const model = promptModel(prompt) ?? lastPromptModel(messages);
    if (!model) {
      this.later(sessionId, current);
      return { action: "skipped", reason: "no_model", turns };
    }
    // This prompt is the first after the compaction.
    this.counts.set(sessionId, 1);
    this.notify(sessionId, "started");
    this.log("info", "auto compaction started", { sessionId, turns, context_tokens: context, after_turns: current.afterTurns });
    const started = Date.now();
    const before = summaryIds(messages);
    const controller = new AbortController();
    let stoppedByPerson = false;
    let timedOut = false;
    const timeoutMs = this.options.timeoutMs ?? COMPACTION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      // The engine goes on compacting after our wait ends: tell it to stop, so its leftovers can be removed.
      void (engine.abort?.() ?? Promise.resolve()).catch(() => undefined).finally(() => controller.abort(new Error("compaction timed out")));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    let grace: ReturnType<typeof setTimeout> | undefined;
    this.stops.set(sessionId, () => {
      stoppedByPerson = true;
      grace ??= setTimeout(() => controller.abort(new Error("compaction stopped")), this.options.stopGraceMs ?? STOP_GRACE_MS);
      (grace as { unref?: () => void }).unref?.();
    });
    const run: Promise<boolean> = engine.summarize(model, controller.signal).then(
      () => null,
      (error: unknown) => error ?? new Error("summarize failed"),
    ).then(async (failure) => {
      // Our wait ended early: give the engine a moment to finish stopping, so its summary is closed before it is read.
      if (failure !== null) await this.idle(engine, this.options.stopGraceMs ?? STOP_GRACE_MS);
      // Summarize answers once the engine is done, also when it was stopped: the chat says how it ended.
      const result = compactionResult(await engine.messages().catch(() => null), before, { cut: failure !== null || stoppedByPerson });
      if (failure === null && result.state !== "broken") {
        this.log("info", "auto compaction finished", { sessionId, elapsed_ms: Date.now() - started });
        this.notify(sessionId, "finished");
        return true;
      }
      const removed = await this.removeLeftovers(engine, result.leftovers);
      const byPerson = stoppedByPerson || result.error === "MessageAbortedError";
      this.log("warn", byPerson ? "auto compaction stopped" : "auto compaction failed", {
        sessionId,
        elapsed_ms: Date.now() - started,
        error: failure === null ? result.error ?? null : errorText(failure),
        timed_out: timedOut,
        removed,
      });
      // Stopped by the person: the count started again at this prompt (a full after_turns); otherwise RETRY_AFTER_TURNS.
      if (!byPerson) this.later(sessionId, current);
      this.notify(sessionId, "failed");
      return false;
    }).finally(() => {
      clearTimeout(timer);
      clearTimeout(grace);
      this.stops.delete(sessionId);
      this.running.delete(sessionId);
    });
    this.running.set(sessionId, run);
    const done = await within(run, holdMs);
    return { action: done === undefined ? "queued" : done ? "compacted" : "failed", turns };
  }
}

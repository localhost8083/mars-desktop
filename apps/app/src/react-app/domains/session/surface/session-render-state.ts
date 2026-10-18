import type { UIMessage } from "ai";

import type { MarsSessionSnapshot } from "../../../../app/lib/mars-server";
import { mergeSnapshotAndLiveMessages } from "../sync/message-merge";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";

const snapshotMessageCache = new WeakMap<MarsSessionSnapshot, UIMessage[]>();

function getSnapshotMessages(snapshot: MarsSessionSnapshot) {
  const cached = snapshotMessageCache.get(snapshot);
  if (cached) return cached;
  const messages = snapshotToUIMessages(snapshot);
  snapshotMessageCache.set(snapshot, messages);
  return messages;
}

export function resolveRenderedSessionSnapshot(input: {
  sessionId: string;
  currentSnapshot: MarsSessionSnapshot | null | undefined;
  cachedRendered: { sessionId: string; snapshot: MarsSessionSnapshot } | null | undefined;
}) {
  if (input.currentSnapshot?.session.id === input.sessionId) {
    return input.currentSnapshot;
  }
  if (
    input.cachedRendered?.sessionId === input.sessionId &&
    input.cachedRendered.snapshot.session.id === input.sessionId
  ) {
    return input.cachedRendered.snapshot;
  }
  return null;
}

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: MarsSessionSnapshot | null | undefined;
}) {
  const revertMessageId = (input.snapshot?.session as any)?.revert?.messageID ?? null;
  const liveMessages = input.transcriptState ?? [];

  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
    ? getSnapshotMessages(input.snapshot)
    : [];

  // Render the server snapshot as the history floor and layer live stream
  // updates on top. During prompt submission the live cache can briefly contain
  // only the new turn; it must not replace the older persisted transcript.
  const messages = snapshotMessages.length > 0
    ? mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, { appendLiveOnlyMessages: true })
    : liveMessages;

  return applyRevertCursor(messages, revertMessageId);
}

import { useMemo } from "react";

import { toast } from "@/components/ui/sonner";
import { useControlAction, type MarsControlAction } from "./control/control-provider";

export const AUTO_COMPACT_NOTICE = "Compacting the conversation to keep it fast…";
export const AUTO_COMPACT_FAILED_NOTICE = "Could not compact the conversation. Continuing as is.";

/** The local server's automatic compaction (session-archive/auto-compact.ts): a short notice while a chat compacts. */
export function AutoCompactNotice() {
  const action = useMemo<MarsControlAction>(() => ({
    id: "auto.compact.notice",
    label: "Automatic compaction notice",
    description: "Show that a chat is being compacted before its next prompt.",
    // The server sends it through the query mailbox: no Control Mode, no visible action animation.
    kind: "query",
    sideEffect: "none",
    requiresArgs: true,
    execute: (args) => {
      const stage = args && typeof args === "object" && "stage" in args ? args.stage : undefined;
      if (stage === "started") toast.info(AUTO_COMPACT_NOTICE);
      else if (stage === "failed") toast.warning(AUTO_COMPACT_FAILED_NOTICE);
      else if (stage !== "finished") return { ok: false, error: "Unknown compaction stage" };
      return { ok: true };
    },
  }), []);
  useControlAction(action);
  return null;
}

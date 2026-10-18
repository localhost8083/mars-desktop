import * as React from "react";

import type { MarsServerClient } from "@/app/lib/mars-server";
import type { Client } from "@/app/types";

type WorkspaceContextValue = {
  client: Client | null;
  opencodeBaseUrl: string;
  marsServerClient: MarsServerClient | null;
  workspaceId: string;
  selectedWorkspaceRoot: string;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = {
  client: Client | null;
  opencodeBaseUrl?: string;
  marsServerClient?: MarsServerClient | null;
  workspaceId?: string;
  selectedWorkspaceRoot: string;
  children: React.ReactNode;
};

export function WorkspaceProvider({
  client,
  opencodeBaseUrl = "",
  marsServerClient = null,
  workspaceId = "",
  selectedWorkspaceRoot,
  children,
}: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({ client, opencodeBaseUrl, marsServerClient, workspaceId, selectedWorkspaceRoot }),
    [client, opencodeBaseUrl, marsServerClient, workspaceId, selectedWorkspaceRoot],
  );

  return React.createElement(WorkspaceContext.Provider, { value }, children);
}

/** Like useWorkspace, but null when rendered outside a WorkspaceProvider. */
export function useWorkspaceMaybe() {
  return React.use(WorkspaceContext);
}

export function useWorkspace() {
  const context = React.use(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}

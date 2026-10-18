import { useMemo } from "react";
import type { GeneratedArtifactViewRevision, WorkflowArtifactPayload } from "@mars/types/workflows";
import { McpAppSandboxView } from "@/components/chat/mcp-app-frame";
import { useWorkspace } from "@/react-app/shell/workspace-provider";

const PREVIEW_ARGUMENTS = {};

/** Chat previews and dashboard apps use the same MCP renderer. */
export function GeneratedAppPreview({ html, payload, title, revision }: {
  html: string;
  payload: WorkflowArtifactPayload;
  title: string;
  revision: GeneratedArtifactViewRevision;
}) {
  const { marsServerClient, workspaceId } = useWorkspace();
  const resource = useMemo(() => ({
    serverName: "mars",
    toolName: `render_artifact_${revision.artifactViewId}`,
    resourceUri: revision.resourceUri,
    html,
    csp: revision.csp,
    prefersBorder: true,
  }), [html, revision]);
  const result = useMemo(() => ({ content: [], structuredContent: payload }), [payload]);
  if (!marsServerClient || !workspaceId) {
    return <p role="status" className="text-sm text-muted-foreground">Connect a workspace to open the preview.</p>;
  }
  return <McpAppSandboxView app={resource} toolName={title} inputArguments={PREVIEW_ARGUMENTS}
    result={result} unavailableNotice="This app could not open. Try reopening it, or ask marsai.click to fix the preview."
    initialHeight={360} readOnly />;
}

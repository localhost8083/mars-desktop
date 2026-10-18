import { getMcpServerName, type McpDirectoryInfo } from "../../../app/constants";
import { CLOUD_MCP_SERVER_NAME } from "./cloud-mcp-user-state";

export function conflictsWithMarsConnect(
  entry: Pick<McpDirectoryInfo, "id" | "name" | "serverName" | "managedBy">,
): boolean {
  const serverName = entry.id ?? getMcpServerName({
    ...entry,
    description: "",
    oauth: false,
  });
  const reservedNames = new Set([CLOUD_MCP_SERVER_NAME, "mars-ai-cloud"]);
  return entry.managedBy !== "mars-connect" && reservedNames.has(serverName);
}

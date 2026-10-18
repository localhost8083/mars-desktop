import { isMarsGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isMarsGatewayRuntime();
}

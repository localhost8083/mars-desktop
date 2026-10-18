import { marsPluginPath } from "./mars-extensions-plugin-path.js";
export function managedPolicyPluginPath(next = false): string {
  return marsPluginPath(next ? "managed-policy-next" : "managed-policy");
}

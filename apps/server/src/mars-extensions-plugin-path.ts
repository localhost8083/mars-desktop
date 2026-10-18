import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function marsPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.MARS_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const marsExtensionsPreviewPluginPath = () => marsPluginPath("mars-extensions-preview");
export const marsChromeDevtoolsPluginPath = () => marsPluginPath("mars-chrome-devtools");
export const marsCapabilitiesKnowledgePluginPath = () => marsPluginPath("mars-capabilities-knowledge");
export const marsAnthropicAdaptiveThinkingPluginPath = () => marsPluginPath("mars-anthropic-adaptive-thinking");
export const marsAnthropicToolSchemaPluginPath = () => marsPluginPath("mars-anthropic-tool-schema");
export const marsOfficeAttachmentsPluginPath = () => marsPluginPath("mars-office-attachments");
export const marsSpreadsheetsPluginPath = () => marsPluginPath("mars-spreadsheets");
export const marsPdfAttachmentsPluginPath = () => marsPluginPath("mars-pdf-attachments");
export const marsTitleRecoveryPluginPath = () => marsPluginPath("mars-title-recovery");
export const marsReasoningEffortPluginPath = () => marsPluginPath("mars-reasoning-effort");
export const marsSwarmPluginPath = () => marsPluginPath("mars-swarm");
export const marsMcpPolicyPluginPath = () => marsPluginPath("mars-mcp-policy");
export const marsBudgetWrapPluginPath = () => marsPluginPath("mars-budget-wrap");
export const marsBuildathonPluginPath = () => marsPluginPath("mars-buildathon");

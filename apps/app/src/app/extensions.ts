// Owned here: reload vocabulary is part of the extension manifest contract.
// types.ts re-exports it for the rest of the app.
export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type MarsExtensionSourceFormat =
  | "agent-plugin"
  | "mars-builtin"
  | "mars-extension-manifest"
  | "claude-plugin"
  | "opencode-plugin"
  | "mcp-directory"
  | "manual";

export type MarsExtensionSource = {
  format: MarsExtensionSourceFormat;
  trusted: boolean;
  origin?: "builtin" | "den" | "workspace" | "local";
  reference?: string;
};

export type MarsExtensionResourceType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "opencode-plugin"
  | "provider"
  | "hook"
  | "context"
  | "secret"
  | "file"
  | "local-service"
  | "native-binary";

export type MarsExtensionResource = {
  type: MarsExtensionResourceType;
  id: string;
  label?: string;
  description?: string;
  path?: string;
  command?: string[];
  envKey?: string;
  packageName?: string;
  providerId?: string;
  mcpServerName?: string;
  localCommandRef?: "mars.computerUseMcp" | "mars.uiMcp";
  required?: boolean;
};

export type MarsExtensionContributionType =
  | "settings-panel"
  | "setup-instructions"
  | "composer-prompt"
  | "session-side-panel"
  | "session-rail-item"
  | "control-actions"
  | "server-route"
  | "native-capability"
  | "test-action";

export type MarsExtensionContribution = {
  type: MarsExtensionContributionType;
  ref?: string;
  label?: string;
  description?: string;
  prompt?: string;
  location?: "settings-detail" | "composer" | "session-right-pane" | "session-rail" | "server" | "native";
};

export type MarsExtensionSetup = {
  instructions?: string;
  primaryCta?: string;
  secondaryCta?: string;
  requiredEnv?: string[];
  testActionRef?: string;
};

export type MarsExtensionLifecycle = {
  reload?: ReloadReason[];
  detection?: string[];
};

// ---------------------------------------------------------------------------
// Enablement — declarative conditions for extension "active" state
// ---------------------------------------------------------------------------

export type EnablementConditionType =
  | "mcp-connected"
  | "plugin-loaded"
  | "provider-connected"
  | "env-set"
  | "permission-granted"
  | "toggle-enabled";

export type EnablementCondition = {
  type: EnablementConditionType;
  /** What to check — MCP server name, plugin id, env key, etc. */
  ref: string;
  /** Human-readable label shown in the UI. */
  label: string;
};

/** Result of evaluating a single enablement condition at runtime. */
export type EnablementResult = {
  condition: EnablementCondition;
  met: boolean;
};

export type MarsExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: MarsExtensionSource;
  icon?: {
    src?: string;
    simpleIconSlug?: string;
  };
  composer?: {
    prompt: string;
  };
  setup?: MarsExtensionSetup;
  resources: MarsExtensionResource[];
  contributions?: MarsExtensionContribution[];
  lifecycle?: MarsExtensionLifecycle;
  /** Declarative conditions that must ALL be true for the extension to be "active". */
  enablement?: EnablementCondition[];
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export type MarsExtensionPlatform = NonNullable<MarsExtensionManifest["platform"]>[number];

export function extensionContribution(
  manifest: MarsExtensionManifest | undefined,
  type: MarsExtensionContributionType,
): MarsExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type);
}

export function extensionResource(
  manifest: MarsExtensionManifest | undefined,
  type: MarsExtensionResourceType,
): MarsExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type);
}

export function isTrustedBuiltInExtension(manifest: MarsExtensionManifest | undefined): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted;
}

export const BUILT_IN_MARS_EXTENSION_MANIFESTS: MarsExtensionManifest[] = [
  {
    schemaVersion: 1,
    id: "mars-browser",
    name: "marsai.click Browser",
    description: "Automate the built-in browser panel that stays visible inside marsai.click.",
    source: { format: "mars-builtin", origin: "builtin", trusted: true },
    icon: { src: "/mars-mark.png" },
    composer: { prompt: "Use the marsai.click Browser extension to " },
    setup: {
      instructions: "marsai.click Browser is ready by default in desktop workspaces.",
    },
    resources: [
      {
        type: "opencode-plugin",
        id: "opencode-chrome-devtools",
        packageName: "opencode-chrome-devtools",
        required: true,
      },
    ],
    contributions: [
      { type: "settings-panel", ref: "mars.browser.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "mars.browser.panel", location: "session-right-pane" },
      { type: "composer-prompt", prompt: "Use the marsai.click Browser extension to ", location: "composer" },
    ],
    enablement: [
      { type: "toggle-enabled", ref: "mars-browser", label: "Enabled" },
    ],
    lifecycle: { reload: ["plugins", "agents"], detection: ["plugin:opencode-chrome-devtools"] },
    defaultEnabled: true,
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Work in the app and window you approve. Read, use accessible controls, or allow mouse and keyboard control with a small window preview.",
    source: { format: "mars-builtin", origin: "builtin", trusted: true },
    icon: { src: "/mars-mark.png" },
    composer: { prompt: "Use Computer Use to " },
    setup: {
      instructions: "Computer Use supports macOS 14+, Windows, and Linux X11. On macOS, grant Accessibility and Screen Recording. Windows and Linux control require the app in front; your input pauses control. Wayland requires a separate desktop portal integration. For each session, choose an app window and allow reading, app controls, or mouse and keyboard. Choose Allow and start in marsai.click. Your input interrupts control; Stop in the preview ends access.",
      primaryCta: "Enable Computer Use",
      secondaryCta: "Check desktop access",
      testActionRef: "mars.computerUse.healthCheck",
    },
    resources: [
      {
        type: "mcp",
        id: "computer-use-mcp",
        label: "Computer Use MCP",
        mcpServerName: "computer-use",
        command: [],
        localCommandRef: "mars.computerUseMcp",
        required: true,
      },
      {
        type: "native-binary",
        id: "computer-use-native",
        label: "Computer Use session runtime",
        packageName: "@mars/computer-use",
        required: true,
      },
    ],
    contributions: [
      { type: "setup-instructions", ref: "mars.computerUse.setup", label: "Setup instructions", location: "settings-detail" },
      { type: "native-capability", ref: "mars.computerUse.axPermissions", label: "Accessibility and Screen Recording" },
      { type: "test-action", ref: "mars.computerUse.healthCheck", label: "Verify Computer Use MCP" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    defaultEnabled: true,
    platform: ["darwin", "windows", "linux"],
  },
  {
    schemaVersion: 1,
    id: "ollama",
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
    source: { format: "mars-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-ollama.svg" },
    composer: { prompt: "Use the Ollama extension to " },
    setup: {
      instructions: "Run Ollama locally, choose or pull a model, then add it as an Mars provider.",
      primaryCta: "Add Ollama model",
      secondaryCta: "Pull model",
    },
    resources: [
      { type: "local-service", id: "ollama-api", label: "Ollama API", description: "http://localhost:11434", required: true },
      { type: "provider", id: "ollama", providerId: "ollama", packageName: "@ai-sdk/openai-compatible", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "mars.ollama.settings", location: "settings-detail" },
      { type: "test-action", ref: "mars.ollama.listModels", label: "Check local models" },
      { type: "composer-prompt", prompt: "Use the Ollama extension to ", location: "composer" },
    ],
    enablement: [
      { type: "provider-connected", ref: "ollama", label: "Ollama provider" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:ollama"] },
  },
];

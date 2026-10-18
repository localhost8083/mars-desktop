import type {
  MarsAffordanceArgument,
  MarsAffordanceDescriptor,
  MarsAffordanceEffects,
  MarsProviderRef,
} from "@mars/types/mars-affordance";
import type {
  MarsFeatureContribution,
  MarsGuidanceDescriptor,
} from "@mars/types/mars-provider";

export type ConnectSkillDescriptor = {
  name: string;
  title?: string;
  description: string;
  capability: string;
};

export type EngineMcpDescriptor = {
  name: string;
  status?: string;
};

const noEffects: MarsAffordanceEffects = {
  data: "none",
  ui: "none",
  external: false,
};
const readEffects: MarsAffordanceEffects = {
  data: "read",
  ui: "none",
  external: false,
};
const writeEffects: MarsAffordanceEffects = {
  data: "write",
  ui: "none",
  external: false,
};

function argument(
  name: string,
  type: MarsAffordanceArgument["type"],
  required: boolean,
  description: string,
): MarsAffordanceArgument {
  return { name, type, required, description };
}

function affordance(input: {
  id: string;
  kind: "query" | "command";
  title: string;
  description: string;
  provider: MarsProviderRef;
  arguments?: MarsAffordanceArgument[];
  effects?: MarsAffordanceEffects;
  tool?: string;
}): MarsAffordanceDescriptor {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    description: input.description,
    provider: input.provider,
    arguments: input.arguments ?? [],
    effects: input.effects ?? noEffects,
    confirmation: "never",
    availability: { enabled: true },
    executor: input.tool
      ? { kind: "tool", tool: input.tool }
      : { kind: "mars" },
  };
}

function sessionContribution(): MarsFeatureContribution {
  const provider: MarsProviderRef = { id: "mars-server", kind: "builtin" };
  return {
    featureId: "sessions",
    provider,
    affordances: [
      affordance({
        id: "session.search",
        kind: "query",
        title: "Find sessions",
        description: "Search session titles and transcripts without changing the visible workbench.",
        provider,
        arguments: [
          argument("query", "string", true, "Text to find in session titles or messages."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
        ],
        effects: readEffects,
      }),
      affordance({
        id: "session.read",
        kind: "query",
        title: "Read a session transcript",
        description: "Read recent messages from a session without opening it.",
        provider,
        arguments: [
          argument("sessionId", "string", true, "Session id returned by session.search."),
          argument("workspaceId", "string", false, "Optional workspace id or name."),
          argument("count", "number", false, "Number of recent messages to return."),
        ],
        effects: readEffects,
      }),
      affordance({
        id: "session.create",
        kind: "command",
        title: "Create sessions",
        description: "Create and start one or more sessions without navigating away.",
        provider,
        arguments: [argument("sessions", "array", true, "Session titles and self-contained prompts.")],
        effects: writeEffects,
      }),
    ],
    guidance: [],
  };
}

function automationContribution(): MarsFeatureContribution {
  const provider: MarsProviderRef = { id: "mars-automations", kind: "builtin" };
  return {
    featureId: "automations",
    provider,
    affordances: [
      affordance({
        id: "automation.propose",
        kind: "command",
        title: "Propose an Automation",
        description: "Offer a scheduled Automation for the person to review and create. This only renders a proposal in the chat; it cannot create, activate, or run anything.",
        provider,
        arguments: [
          argument("name", "string", true, "Short Automation name, at most 120 characters."),
          argument("instructions", "string", true, "Self-contained instructions the Automation runs on its schedule."),
          argument("schedule", "object", true, "once/daily/weekly schedule with an IANA timezone. Intervals are not supported."),
          argument("model", "object", false, "Optional providerId and modelId. Omit to use the person's default."),
        ],
        effects: noEffects,
      }),
    ],
    guidance: [],
  };
}

function extensionContribution(): MarsFeatureContribution {
  const provider: MarsProviderRef = { id: "mars-extensions", kind: "extension" };
  return {
    featureId: "extensions",
    provider,
    affordances: [
      affordance({
        id: "extension.actions",
        kind: "query",
        title: "List extension actions",
        description: "List actions exposed by enabled local MarsAI extensions.",
        provider,
        arguments: [argument("extensionId", "string", false, "Optional extension id.")],
        effects: readEffects,
      }),
      affordance({
        id: "extension.call",
        kind: "command",
        title: "Call an extension action",
        description: "Execute one action exposed by a local MarsAI extension.",
        provider,
        arguments: [
          argument("extensionId", "string", true, "Extension id."),
          argument("action", "string", true, "Action id returned by extension.actions."),
          argument("args", "object", false, "Extension action arguments."),
        ],
        effects: { data: "write", ui: "none", external: true },
      }),
    ],
    guidance: [],
  };
}

function connectContribution(
  skills: ConnectSkillDescriptor[],
  cloudMcp: EngineMcpDescriptor | undefined,
): MarsFeatureContribution | null {
  if (skills.length === 0 && !cloudMcp) return null;
  const provider: MarsProviderRef = { id: "mars-cloud", kind: "connect" };
  const guidance: MarsGuidanceDescriptor[] = skills.map((skill) => ({
    ref: skill.capability,
    title: skill.title?.trim() || skill.name,
    description: skill.description,
    provider,
    loading: "catalog",
  }));
  return {
    featureId: "connect",
    provider,
    affordances: [
      affordance({
        id: "connect.capabilities.search",
        kind: "query",
        title: "Search Connect capabilities",
        description: "Discover a remote capability when no exact capability ref is already known.",
        provider,
        arguments: [
          argument("query", "string", true, "Capability keywords."),
          argument("limit", "number", false, "Maximum capabilities to return."),
          argument("type", "string", false, "Optional capability type filter."),
        ],
        effects: { data: "read", ui: "none", external: true },
        tool: "mars-cloud_search_capabilities",
      }),
      affordance({
        id: "connect.capability.execute",
        kind: "command",
        title: "Execute a Connect capability",
        description: "Execute an exact remote capability ref or load a known remote skill.",
        provider,
        arguments: [
          argument("name", "string", false, "Exact capability ref returned by Connect search or remote skill guidance."),
          argument("schemaDigest", "string", false, "Schema digest returned by Connect search when required."),
          argument("path", "object", false, "Path parameters for the capability."),
          argument("query", "object", false, "Query parameters for the capability."),
          argument("body", "object", false, "Request body for the capability."),
        ],
        effects: { data: "write", ui: "none", external: true },
        tool: "mars-cloud_execute_capability",
      }),
    ],
    guidance,
  };
}

function mcpContribution(mcp: EngineMcpDescriptor): MarsFeatureContribution {
  return {
    featureId: `mcp:${mcp.name}`,
    provider: { id: mcp.name, kind: "mcp" },
    affordances: [],
    guidance: [],
  };
}

export function buildMarsProviderContributions(
  skills: ConnectSkillDescriptor[],
  mcps: EngineMcpDescriptor[] = [],
): MarsFeatureContribution[] {
  const cloudMcp = mcps.find((mcp) => mcp.name === "mars-cloud");
  const connect = connectContribution(skills, cloudMcp);
  return [
    sessionContribution(),
    automationContribution(),
    extensionContribution(),
    ...mcps
      .filter((mcp) => mcp.name !== "mars-cloud")
      .map(mcpContribution),
    ...(connect ? [connect] : []),
  ];
}

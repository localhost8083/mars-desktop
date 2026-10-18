import { z } from "zod"

import {
  marsAffordanceDescriptorSchema,
  marsProviderRefSchema,
} from "./mars-affordance.js"
import { marsFeatureContributionSchema } from "./mars-provider.js"

export const MARS_CONTEXT_SCHEMA_VERSION = 1

export const marsSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type MarsSessionRef = z.infer<typeof marsSessionRefSchema>

export const marsScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type MarsScreen = z.infer<typeof marsScreenSchema>

export const marsConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
    workspaceId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    primaryWorkspaceId: z.string().optional(),
    secondarySessionId: z.string(),
    secondaryWorkspaceId: z.string().optional(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type MarsConversationLayout = z.infer<typeof marsConversationLayoutSchema>

export const marsPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready", "suspending", "suspended", "restoring"]).optional(),
})
export type MarsPanelTab = z.infer<typeof marsPanelTabSchema>

export const marsResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: marsProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type MarsResourceDescriptor = z.infer<typeof marsResourceDescriptorSchema>

export const marsContextSnapshotSchema = z.object({
  schemaVersion: z.literal(MARS_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  screen: marsScreenSchema,
  conversations: z.object({
    tabs: z.array(marsSessionRefSchema),
    layout: marsConversationLayoutSchema,
    pinnedSessionIds: z.array(z.string()),
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions"]).nullable(),
    tabs: z.array(marsPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(marsResourceDescriptorSchema),
  availableAffordances: z.array(marsAffordanceDescriptorSchema),
  contributions: z.array(marsFeatureContributionSchema),
})
export type MarsContextSnapshot = z.infer<typeof marsContextSnapshotSchema>

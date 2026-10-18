import { z } from "zod"

export const MARS_AFFORDANCE_SCHEMA_VERSION = 1

export const marsAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type MarsAffordanceKind = z.infer<typeof marsAffordanceKindSchema>

export const marsProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type MarsProviderKind = z.infer<typeof marsProviderKindSchema>

export const marsProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: marsProviderKindSchema,
})
export type MarsProviderRef = z.infer<typeof marsProviderRefSchema>

export const marsAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type MarsAffordanceArgument = z.infer<typeof marsAffordanceArgumentSchema>

export const marsAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type MarsAffordanceEffects = z.infer<typeof marsAffordanceEffectsSchema>

export const marsAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type MarsAffordanceAvailability = z.infer<typeof marsAffordanceAvailabilitySchema>

export const marsAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mars") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type MarsAffordanceExecutor = z.infer<typeof marsAffordanceExecutorSchema>

export const marsAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: marsAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: marsProviderRefSchema,
  arguments: z.array(marsAffordanceArgumentSchema),
  effects: marsAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: marsAffordanceAvailabilitySchema,
  executor: marsAffordanceExecutorSchema,
})
export type MarsAffordanceDescriptor = z.infer<typeof marsAffordanceDescriptorSchema>

/**
 * Where a request came from: the conversation (session) whose agent issued
 * it. Set by the MarsAI bridge, never by the agent, so UI commands such as
 * opening a browser tab can act for the requesting conversation instead of
 * whichever one happens to be on screen.
 */
export const marsAffordanceOriginSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
})
export type MarsAffordanceOrigin = z.infer<typeof marsAffordanceOriginSchema>

export const marsAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
  origin: marsAffordanceOriginSchema.optional(),
})
export type MarsAffordanceRequest = z.infer<typeof marsAffordanceRequestSchema>

const marsAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: marsAffordanceEffectsSchema,
})

const marsAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const marsAffordanceResultSchema = z.discriminatedUnion("ok", [
  marsAffordanceSuccessSchema,
  marsAffordanceFailureSchema,
])
export type MarsAffordanceResult = z.infer<typeof marsAffordanceResultSchema>

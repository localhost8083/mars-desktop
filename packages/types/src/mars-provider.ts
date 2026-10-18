import { z } from "zod"

import {
  marsAffordanceDescriptorSchema,
  marsProviderRefSchema,
} from "./mars-affordance.js"

export const marsGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: marsProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type MarsGuidanceDescriptor = z.infer<typeof marsGuidanceDescriptorSchema>

export const marsFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: marsProviderRefSchema,
  affordances: z.array(marsAffordanceDescriptorSchema),
  guidance: z.array(marsGuidanceDescriptorSchema),
})
export type MarsFeatureContribution = z.infer<typeof marsFeatureContributionSchema>

export const marsProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(marsFeatureContributionSchema),
})
export type MarsProviderCatalog = z.infer<typeof marsProviderCatalogSchema>

export const marsCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type MarsCapabilityResult = z.infer<typeof marsCapabilityResultSchema>

import { describe, expect, test } from "bun:test";
import { marsFeatureContributionSchema } from "@mars/types/mars-provider";

import { buildMarsProviderContributions } from "./mars-provider-adapters.js";

describe("MarsAI provider adapters", () => {
  test("normalizes sessions and extensions into semantic contributions", () => {
    const contributions = buildMarsProviderContributions([]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
    ]);
    expect(
      contributions.flatMap((contribution) => contribution.affordances)
        .find((affordance) => affordance.id === "session.read"),
    ).toMatchObject({
      kind: "query",
      effects: { data: "read", ui: "none", external: false },
      executor: { kind: "mars" },
    });
    for (const contribution of contributions) {
      expect(marsFeatureContributionSchema.safeParse(contribution).success).toBe(true);
    }
  });

  test("keeps known Connect skills direct and search available for unknown capabilities", () => {
    const contributions = buildMarsProviderContributions([{
      name: "customer-briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      capability: "skill:skl_customer_briefing",
    }]);
    const connect = contributions.find((contribution) => contribution.featureId === "connect");

    expect(connect?.guidance).toEqual([{
      ref: "skill:skl_customer_briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      provider: { id: "mars-cloud", kind: "connect" },
      loading: "catalog",
    }]);
    expect(connect?.affordances.map((affordance) => ({
      id: affordance.id,
      executor: affordance.executor,
    }))).toEqual([
      {
        id: "connect.capabilities.search",
        executor: { kind: "tool", tool: "mars-cloud_search_capabilities" },
      },
      {
        id: "connect.capability.execute",
        executor: { kind: "tool", tool: "mars-cloud_execute_capability" },
      },
    ]);
    expect(
      connect?.affordances.find((affordance) => affordance.id === "connect.capability.execute")
        ?.arguments.map((argument) => argument.name),
    ).toEqual(["name", "schemaDigest", "path", "query", "body"]);
  });

  test("includes only MCP providers observed from the engine", () => {
    const contributions = buildMarsProviderContributions([], [
      { name: "notion", status: "connected" },
      { name: "mars-cloud", status: "connected" },
    ]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
      "mcp:notion",
      "connect",
    ]);
    expect(contributions[3]).toMatchObject({
      provider: { id: "notion", kind: "mcp" },
      affordances: [],
    });
    expect(contributions[4]?.affordances.map((affordance) => affordance.id)).toEqual([
      "connect.capabilities.search",
      "connect.capability.execute",
    ]);
  });

  test("exposes an Automations proposal affordance that writes nothing", () => {
    const proposal = buildMarsProviderContributions([])
      .flatMap((contribution) => contribution.affordances)
      .find((affordance) => affordance.id === "automation.propose");

    expect(proposal).toMatchObject({
      kind: "command",
      // No data effect: a proposal is rendered for a person, never persisted.
      effects: { data: "none", ui: "none", external: false },
      executor: { kind: "mars" },
    });
    expect(proposal?.arguments.map((argument) => argument.name)).toEqual([
      "name",
      "instructions",
      "schedule",
      "model",
    ]);
    expect(proposal?.arguments.find((argument) => argument.name === "model")?.required).toBe(false);
  });
});

// Engine plugin: in a buildathon project (buildathon-repro.ts; the app lists
// them), the event's reproducibility rules join the chat's instructions.
// The CLI adds the same text as an engine instructions file in its own state
// folder; neither ever writes into the project. Other folders are left alone.
// The engine calls every function this module exports: export only the plugin.

import path from "node:path";

import { agentRulesFor } from "../buildathon-repro.js";

export const MarsBuildathon = async ({ directory }: { directory?: string }) => {
  const root = path.resolve(directory || process.cwd());
  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system?: unknown }) => {
      if (!Array.isArray(output.system)) return;
      let rules: string | null = null;
      try {
        rules = agentRulesFor(root);
      } catch {
        rules = null;
      }
      // In place: the engine keeps its own reference to this array.
      if (rules && !output.system.includes(rules)) output.system.push(rules);
    },
  };
};

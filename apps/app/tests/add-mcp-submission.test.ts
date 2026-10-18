import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import { conflictsWithMarsConnect } from "../src/react-app/domains/connections/mcp-connection-boundary";
import { submitMcpEntry } from "../src/react-app/domains/connections/modals/add-mcp-submission";

const entry: McpDirectoryInfo = {
  name: "BigQuery",
  description: "",
  type: "remote",
  url: "https://bigquery.googleapis.com/mcp",
  oauth: true,
  managedOAuth: true,
};

describe("local MCP submission feedback", () => {
  test("reserves the MarsAI Connect runtime name for its managed entry", () => {
    expect(conflictsWithMarsConnect({ name: "MarsAI Cloud" })).toBe(true);
    expect(conflictsWithMarsConnect({ name: "mars-cloud" })).toBe(true);
    expect(conflictsWithMarsConnect({ id: "mars-cloud", name: "Custom cloud" })).toBe(true);
    expect(conflictsWithMarsConnect({
      name: "MarsAI Cloud",
      serverName: "mars-cloud",
      managedBy: "mars-connect",
    })).toBe(false);
    expect(conflictsWithMarsConnect({ name: "BigQuery" })).toBe(false);
  });

  test("returns no error only after the connection succeeds", async () => {
    expect(await submitMcpEntry(async () => ({ ok: true }), entry, "Fallback")).toBeNull();
  });

  test("preserves the server error when the connection fails", async () => {
    expect(await submitMcpEntry(
      async () => ({ ok: false, error: "Secure storage is unavailable." }),
      entry,
      "Fallback",
    )).toBe("Secure storage is unavailable.");
  });

  test("turns a rejected connection into inline feedback", async () => {
    expect(await submitMcpEntry(
      async () => {
        throw new Error("Unexpected server error");
      },
      entry,
      "Fallback",
    )).toBe("Unexpected server error");
  });
});

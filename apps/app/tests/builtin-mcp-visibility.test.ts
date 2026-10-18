import { describe, expect, test } from "bun:test";

import { MCP_QUICK_CONNECT } from "../src/app/constants";

describe("built-in MarsAI MCP visibility", () => {
  test("hides internal MarsAI MCPs and omits the retired admin connector", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "mars-cloud")?.defaultHidden).toBe(true);
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "mars-admin")).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "mars-ui")?.defaultHidden).toBe(true);
  });

  test("keeps directory apps visible by default", () => {
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "notion")?.defaultHidden).toBeUndefined();
    expect(MCP_QUICK_CONNECT.find((entry) => entry.serverName === "linear")?.defaultHidden).toBeUndefined();
  });
});

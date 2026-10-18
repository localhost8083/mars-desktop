import { describe, expect, test } from "bun:test";

import {
  isMarsUiMcpRegistryCommand,
  isMarsUiMcpRegistryEntry,
  withoutMarsUiMcpRegistryEntries,
} from "./mars-ui-mcp-command.js";

describe("registry launches of mars-ui-mcp", () => {
  test("matches every command that resolves the package by name", () => {
    for (const command of [
      ["npx", "-y", "mars-ui-mcp"],
      ["npx", "mars-ui-mcp"],
      ["npx", "--yes", "mars-ui-mcp@latest"],
      ["npx", "-y", "mars-ui-mcp@1.0.8", "--flag"],
      ["npx", "--package=mars-ui-mcp", "mars-ui"],
      ["npx", "-p", "mars-ui-mcp", "mars-ui"],
      ["/usr/local/bin/npx", "-y", "mars-ui-mcp"],
      ["C:\\Program Files\\nodejs\\npx.cmd", "-y", "mars-ui-mcp"],
      ["bunx", "mars-ui-mcp"],
      ["bun", "x", "mars-ui-mcp"],
      ["pnpm", "dlx", "mars-ui-mcp"],
      ["pnpx", "mars-ui-mcp"],
      ["yarn", "dlx", "mars-ui-mcp"],
      ["npm", "exec", "--yes", "--", "mars-ui-mcp"],
      ["npx", "-y", "npm:mars-ui-mcp"],
      ["npx", "-y", "MARS-UI-MCP"],
      ["mars-ui-mcp"],
      ["sh", "-c", "npx -y mars-ui-mcp"],
      ["bash", "-lc", "cd /tmp && npx -y 'mars-ui-mcp'"],
      ["cmd", "/c", "npx", "-y", "mars-ui-mcp"],
    ]) {
      expect({ command, match: isMarsUiMcpRegistryCommand(command) }).toEqual({ command, match: true });
    }
  });

  test("does not match the bundled launch, a checkout path, or other packages", () => {
    for (const command of [
      [
        "/Applications/MarsAI.app/Contents/MacOS/MarsAI",
        "/Applications/MarsAI.app/Contents/Resources/mars-ui-mcp/index.mjs",
      ],
      [
        "C:\\Users\\me\\AppData\\Local\\Programs\\MarsAI\\MarsAI.exe",
        "C:\\Users\\me\\AppData\\Local\\Programs\\MarsAI\\resources\\mars-ui-mcp\\index.mjs",
      ],
      ["node", "/Users/me/MarsAI/packages/mars-ui-mcp/index.mjs"],
      ["node", "packages/mars-ui-mcp"],
      ["npx", "-y", "@modelcontextprotocol/server-everything"],
      ["npx", "-y", "mars-ui-mcp-helper"],
      ["npx", "-y", "@acme/mars-ui-mcp"],
      [],
    ]) {
      expect({ command, match: isMarsUiMcpRegistryCommand(command) }).toEqual({ command, match: false });
    }
    expect(isMarsUiMcpRegistryCommand("npx -y mars-ui-mcp")).toBe(false);
    expect(isMarsUiMcpRegistryCommand(undefined)).toBe(false);
  });

  test("checks entries by command and filters them out of an MCP map", () => {
    const legacy = { type: "local", command: ["npx", "-y", "mars-ui-mcp"], enabled: false };
    const safe = { type: "local", command: ["node", "/opt/mcp/index.mjs"] };
    const remote = { type: "remote", url: "https://mcp.example.com/mcp" };
    expect(isMarsUiMcpRegistryEntry(legacy)).toBe(true);
    expect(isMarsUiMcpRegistryEntry(safe)).toBe(false);
    expect(isMarsUiMcpRegistryEntry(remote)).toBe(false);
    expect(isMarsUiMcpRegistryEntry(null)).toBe(false);

    const clean = { safe, remote };
    expect(withoutMarsUiMcpRegistryEntries(clean)).toBe(clean);
    expect(withoutMarsUiMcpRegistryEntries({ "mars-ui": legacy, ...clean })).toEqual(clean);
  });
});

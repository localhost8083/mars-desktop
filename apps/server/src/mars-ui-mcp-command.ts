/**
 * `mars-ui-mcp` is not a package MarsAI publishes on npm, yet desktop
 * releases 1.0.0 to 1.0.8 configured the built-in UI-control MCP as
 * `npx -y mars-ui-mcp`. Whoever registers that name gets code execution
 * on every host that resolves it from a registry. The desktop now bundles the
 * MCP and launches it by absolute path, so no legitimate command names the
 * package: any command that does is refused on write and never delivered to
 * the engine.
 *
 * Kept free of other server imports so validators, the runtime config store,
 * and the engine config builder can all share it without import cycles.
 */

/**
 * A bare package reference: `mars-ui-mcp`, `mars-ui-mcp@<version|tag>`,
 * `npm:mars-ui-mcp`, or `--package=mars-ui-mcp`. A path to the
 * bundled file (`.../mars-ui-mcp/index.mjs`) never matches.
 */
const PACKAGE_REFERENCE = /^(?:--package=|-p=)?(?:npm:)?mars-ui-mcp(?:@\S*)?$/i;

/** Shell word and statement separators, so `sh -c "npx -y mars-ui-mcp"` is caught too. */
const TOKEN_SEPARATORS = /[\s"'`;&|()<>]+/;

export const MARS_UI_MCP_REGISTRY_COMMAND_MESSAGE =
  "mars-ui-mcp is not published on npm and cannot be launched through npx, bunx, pnpm dlx or another package runner. "
  + "Connect UI control from Settings > Extensions in the marsai.click desktop app, which runs the copy bundled with the app.";

/**
 * True when a local MCP command resolves `mars-ui-mcp` by package name
 * (npx, bunx, pnpm dlx, yarn dlx, npm exec, bun x, a PATH lookup of a global
 * install, or any of these inside a shell string) rather than running the
 * bundled file by path.
 */
export function isMarsUiMcpRegistryCommand(command: unknown): boolean {
  if (!Array.isArray(command)) return false;
  return command.some((part) =>
    typeof part === "string"
    && part.split(TOKEN_SEPARATORS).some((token) => PACKAGE_REFERENCE.test(token))
  );
}

/** True for an MCP entry whose `command` is a registry launch of `mars-ui-mcp`. */
export function isMarsUiMcpRegistryEntry(entry: unknown): boolean {
  return typeof entry === "object"
    && entry !== null
    && !Array.isArray(entry)
    && isMarsUiMcpRegistryCommand((entry as Record<string, unknown>).command);
}

/** Drops registry launches of `mars-ui-mcp` from an MCP map; returns the same map when there are none. */
export function withoutMarsUiMcpRegistryEntries<T>(mcp: Record<string, T>): Record<string, T> {
  const blocked = Object.keys(mcp).filter((name) => isMarsUiMcpRegistryEntry(mcp[name]));
  if (blocked.length === 0) return mcp;
  return Object.fromEntries(Object.entries(mcp).filter(([name]) => !blocked.includes(name)));
}

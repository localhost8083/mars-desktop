# GUI PR #112 review handoff

- Repository: mars-ai/mars-gui
- Branch: feat/disable-mcp-production
- Source commits: 19069df (current-main conflict resolution) and 3f24f0b (deny-only MCP policy)
- Scope: deny MCP at the GUI/server boundaries, including v1 and v2 runtime config, preview sync, managed OpenCode plugin/tool dispatch, cloud/plugin routes, and HTTP configuration paths. MCP add/configure/enable requests are refused; legacy rows remain available only for cleanup and are not injected into runtime or engine state. Non-MCP plugin install and cleanup behavior remains available. No local or Harbor exception is retained.
- Verification: focused server suite with MARS_OPENCODE2_BIN set to a nonexistent path (so the optional real-sidecar test is skipped): 69 passed, 1 skipped, 0 failed, 392 assertions across 6 files.
- Verification: pnpm --filter mars-server typecheck passed (Node 22 emitted only the existing workspace engine warning).
- Verification: git diff --check passed.
- Environment note: the optional real OpenCode v2 sidecar test was attempted with the available sidecar and timed out waiting for its loopback connection; it is therefore recorded as an environment-blocked check rather than claimed as passed.
- Status: proposed/open; pushed for review; not merged, deployed, or released.

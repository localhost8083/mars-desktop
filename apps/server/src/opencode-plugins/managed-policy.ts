import { annotateShellOutput, check, checkManagedTool } from "./managed-policy-client.js";
import { applyEnginePath } from "../engine-shell-path.js";

type ToolBeforeInput = { tool: string; sessionID?: string; callID?: string };
type ToolAfterInput = { tool: string; sessionID?: string; callID?: string; args?: unknown };

export default async function managedPolicy(input?: { directory?: string }) {
  // Same tool directories the packaged app resolves for the server, applied
  // to the engine process so the bash tool finds git and gh in dev too.
  const enginePath = applyEnginePath();
  const directory = input?.directory;
  return {
    "tool.execute.before": async (event: ToolBeforeInput, output: { args: unknown }) =>
      checkManagedTool(event.tool, output.args, { directory, callID: event.callID, sessionID: event.sessionID }),
    "tool.execute.after": async (event: ToolAfterInput, output: { title: string; output: string; metadata: unknown }) => {
      if (event.tool !== "bash" && event.tool !== "shell") return;
      output.output = annotateShellOutput(event.callID, output.output);
    },
    "shell.env": async (event: { cwd: string; callID?: string; sessionID?: string }, output: { env: Record<string, string> }) => {
      if (enginePath) output.env.PATH = enginePath;
      // The call and session the shell runs for: the install log's wrappers note them, so an
      // install is tied to the very call that ran it (parallel calls, a sub-agent's, one in the background).
      if (event?.callID) output.env.MARS_CALL = String(event.callID);
      if (event?.sessionID) output.env.MARS_SESSION = String(event.sessionID);
      // The engine runs with a data home of its own (engine-data-home.ts);
      // commands the agent runs get the user's back.
      const userDataHome = process.env.MARS_USER_XDG_DATA_HOME?.trim();
      if (userDataHome) output.env.XDG_DATA_HOME = userDataHome;
      // Same for the config home: the engine reads a MarsAI-owned config
      // directory, the agent's commands (git, gh, …) read the user's.
      const userConfigHome = process.env.MARS_USER_XDG_CONFIG_HOME?.trim();
      if (userConfigHome) output.env.XDG_CONFIG_HOME = userConfigHome;
    },
    "chat.params": async (input: { model: { providerID: string; id: string } }) => { await check("model", input.model); },
  };
}

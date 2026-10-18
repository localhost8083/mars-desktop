/**
 * The install log's wrappers for the engines this server starts
 * (context/install-log.ts): written once at startup under the runtime state
 * folder; every managed engine then gets them first on its PATH (and the pip
 * hook on its PYTHONPATH), so only the shells the engine starts for tool calls
 * see them. MARS_INSTALL_LOG=0 leaves them out. Whether anything is noted
 * and sent is the server's call (capabilities `install_log`), read by the
 * session uploader.
 */
import { installLogEnv, installLogLocallyEnabled, prepareInstallLog, type InstallLogPaths } from "./context/install-log.js";

let prepared: InstallLogPaths | null = null;

/** Writes the wrappers (once per version) and this process's raw folder. */
export async function prepareDesktopInstallLog(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<InstallLogPaths | null> {
  if (!installLogLocallyEnabled(env)) return null;
  prepared ??= await prepareInstallLog({ stateDir });
  return prepared;
}

/** What a managed engine's environment gets (nothing before prepareDesktopInstallLog, or when it failed). */
export function engineInstallLogEnv(base: Record<string, string | undefined>): Record<string, string> {
  return prepared ? installLogEnv(prepared, base) : {};
}

/** Tests: forget the prepared wrappers. */
export function resetDesktopInstallLog(): void {
  prepared = null;
}

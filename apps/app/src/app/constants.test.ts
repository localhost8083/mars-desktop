declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  BUILTIN_MARS_MODEL_IDS,
  DEFAULT_MODEL,
  isMarsModelID,
  MARS_EXTENSION_CATALOG,
  MCP_QUICK_CONNECT,
  filterMarsExtensionCatalogForPlatform,
  resolveMarsExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterMarsExtensionCatalogForPlatform(MARS_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("marsai.click extension catalog platform filter", () => {
  test("defaults new conversations to a model the catalog serves", () => {
    expect(DEFAULT_MODEL).toEqual({ providerID: "mars", modelID: "claude-opus-5-5" });
  });

  test("recognises every marsai.click catalog model, not just the built-in ones", () => {
    expect([...BUILTIN_MARS_MODEL_IDS]).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
    expect(isMarsModelID("claude-opus-5-5")).toEqual(true);
    expect(isMarsModelID("claude-sonnet-5")).toEqual(true);
    expect(isMarsModelID("nova-9.0.1-preview")).toEqual(true);
    // Retired launch-era routes reset to the default when found in storage.
    expect(isMarsModelID("gpt-6-sol")).toEqual(false);
    expect(isMarsModelID("gpt-6.1-sol")).toEqual(false);
    expect(isMarsModelID("GPT-6-Astra")).toEqual(false);
    expect(isMarsModelID("gpt-5.6-sol")).toEqual(false);
    expect(isMarsModelID("meta-muse-spark")).toEqual(false);
    expect(isMarsModelID("muse-spark-1.3")).toEqual(false);
    expect(isMarsModelID("z-ai/glm-5.2")).toEqual(false);
    expect(isMarsModelID("")).toEqual(false);
  });

  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveMarsExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveMarsExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveMarsExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveMarsExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["ollama"]);
  });

  test("keeps Browser on desktop platforms; paused Computer Use stays hidden", () => {
    expect(filteredIds("darwin")).toEqual(["mars-browser", "ollama"]);
    expect(filteredIds("linux")).toEqual(["mars-browser", "ollama"]);
    expect(filteredIds("windows")).toEqual(["mars-browser", "ollama"]);
  });

  test("ships Computer Use without the preview catalog badge", () => {
    const computerUse = MCP_QUICK_CONNECT.find((entry) => entry.id === "computer-use");
    expect(computerUse?.extensionManifest?.preview).toEqual(undefined);
  });
});

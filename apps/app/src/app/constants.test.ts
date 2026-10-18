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
  test("defaults new conversations to the internal Astra route", () => {
    expect(DEFAULT_MODEL).toEqual({ providerID: "mars", modelID: "gpt-6-astra" });
  });

  test("recognises every marsai.click catalog model, not just the built-in ones", () => {
    expect([...BUILTIN_MARS_MODEL_IDS]).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]);
    expect(isMarsModelID("gpt-6-sol")).toEqual(true);
    expect(isMarsModelID("gpt-6.1-sol")).toEqual(true);
    expect(isMarsModelID("nova-9.0.1-preview")).toEqual(true);
    expect(isMarsModelID("gpt-5.6-sol")).toEqual(true);
    expect(isMarsModelID("GPT-6-Astra")).toEqual(true);
    expect(isMarsModelID("meta-muse-spark")).toEqual(true);
    expect(isMarsModelID("muse-spark-1.3")).toEqual(true);
    // The launch release's retired route is not a catalog id.
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

  test("keeps Browser and Computer Use on desktop platforms", () => {
    expect(filteredIds("darwin")).toEqual(["mars-browser", "computer-use", "ollama"]);
    expect(filteredIds("linux")).toEqual(["mars-browser", "computer-use", "ollama"]);
    expect(filteredIds("windows")).toEqual(["mars-browser", "computer-use", "ollama"]);
  });

  test("ships Computer Use without the preview catalog badge", () => {
    const computerUse = MCP_QUICK_CONNECT.find((entry) => entry.id === "computer-use");
    expect(computerUse?.extensionManifest?.preview).toEqual(undefined);
  });
});

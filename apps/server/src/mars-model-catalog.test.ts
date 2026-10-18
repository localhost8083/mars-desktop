import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builtinMarsModelCatalog,
  canonicalMarsModelCatalog,
  clearMarsModelCatalog,
  engineModelsFromCatalog,
  marsDefaultModelId,
  marsModelCatalogPath,
  marsModelWantsReasoningSummary,
  readMarsModelCatalog,
  sanitizeMarsModelCatalog,
  writeMarsModelCatalog,
  type MarsModelCatalog,
} from "./mars-model-catalog.js";
import type { ServerConfig } from "./types.js";
import { backendCatalogBody } from "./__fixtures__/mars-model-catalog.js";

const roots: string[] = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.MARS_RUNTIME_DB;
  else process.env.MARS_RUNTIME_DB = previousDb;
});

async function setupConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "mars-model-catalog-"));
  roots.push(root);
  previousDb = process.env.MARS_RUNTIME_DB;
  process.env.MARS_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

/** Every key path of a JSON value, e.g. "0.capabilities.web_search". */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keyPaths(entry, `${prefix}${index}.`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)]);
}

describe("mars model catalog sanitizer", () => {
  test("reads the backend catalog: Astra first and default, Muse under its family with its own efforts", () => {
    const catalog = sanitizeMarsModelCatalog(backendCatalogBody());
    expect(catalog?.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]);
    expect(catalog && marsDefaultModelId(catalog)).toBe("gpt-6-astra");
    expect(catalog?.filter((model) => model.default).map((model) => model.id)).toEqual(["gpt-6-astra"]);
    expect(catalog?.[5]).toEqual({
      id: "muse-spark-1.3",
      display_name: "Meta Muse Spark 1.3",
      family: "Meta Muse",
      status: "beta",
      default: false,
      reasoning_levels: ["minimal", "low", "medium", "high", "xhigh"],
      limits: { context: 99_000, output: 16_000 },
      capabilities: { reasoning: true, tool_call: true, web_search: true, image_input: false, file_input: false },
    });
  });

  test("Astra, GPT 6.1 Sol and GPT 6 Sol from the backend equal the built-in catalog, so a Muse-less account never reloads", () => {
    const body = backendCatalogBody();
    const openaiOnly = { ...body, data: body.data.slice(0, 3) };
    const catalog = sanitizeMarsModelCatalog(openaiOnly);
    expect(catalog).not.toBeNull();
    expect(canonicalMarsModelCatalog(catalog!)).toBe(canonicalMarsModelCatalog(builtinMarsModelCatalog()));
  });

  test("never takes provider plumbing from the backend, at any depth", () => {
    const body = backendCatalogBody();
    const hostile = {
      ...body,
      npm: "evil-sdk",
      baseURL: "https://attacker.example",
      provider: { npm: "evil-sdk" },
      data: body.data.map((model) => ({
        ...model,
        npm: "evil-sdk",
        baseURL: "https://attacker.example/v1",
        headers: { authorization: "Bearer stolen" },
        env: ["AWS_SECRET_ACCESS_KEY"],
        options: { baseURL: "https://attacker.example/v1" },
        provider: { npm: "evil-sdk", api: "https://attacker.example" },
        upstream_model: "internal-codename",
        limits: { ...model.limits, input: 5, url: "https://attacker.example" },
        capabilities: { ...model.capabilities, attachment: true, shell: true },
      })),
    };
    const catalog = sanitizeMarsModelCatalog(hostile);
    const allowed = new Set([
      "id", "display_name", "family", "status", "default", "reasoning_levels", "limits", "limits.context", "limits.output",
      "capabilities", "capabilities.reasoning", "capabilities.tool_call", "capabilities.web_search",
      "capabilities.image_input", "capabilities.file_input",
    ]);
    const paths = keyPaths(catalog).map((path) => path.replace(/^\d+\./, "")).filter((path) => !/^\d+$/.test(path));
    expect(paths.filter((path) => !allowed.has(path) && !/^reasoning_levels\.\d+$/.test(path))).toEqual([]);
    const text = JSON.stringify(catalog);
    for (const leaked of ["evil-sdk", "attacker.example", "stolen", "AWS_SECRET", "internal-codename"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("drops bad ids, duplicates, non-Responses models and wrong types; clamps limits", () => {
    const catalog = sanitizeMarsModelCatalog({
      data: [
        { id: "../../etc/passwd", display_name: "Path" },
        { id: "z-ai/glm-5.2", display_name: "Slash" },
        { id: "-leading-dash", display_name: "Dash" },
        { id: "a".repeat(129), display_name: "Long" },
        { id: 42, display_name: "Number" },
        "not-an-object",
        { id: "chat-only", display_name: "Chat", api: "chat" },
        {
          id: "new-model:v2",
          display_name: "  New\u0007 Model‮  ",
          family: "x".repeat(40),
          status: "retired",
          default: "yes",
          reasoning_levels: ["ultra", "high", "HIGH", "low", 3, "low"],
          limits: { context: 10, output: 9_999_999 },
          capabilities: { reasoning: "true", tool_call: false },
        },
        { id: "new-model:v2", display_name: "Duplicate" },
      ],
    });
    expect(catalog).toEqual([
      {
        id: "z-ai/glm-5.2",
        display_name: "Slash",
        family: null,
        status: "active",
        default: true,
        reasoning_levels: ["low", "high", "xhigh", "max"],
        limits: { context: 400_000, output: 128_000 },
        capabilities: { reasoning: true, tool_call: true, web_search: true, image_input: true, file_input: true },
      },
      {
        id: "new-model:v2",
        display_name: "New Model",
        family: null,
        status: "active",
        default: false,
        reasoning_levels: ["low", "high"],
        limits: { context: 1_000, output: 1_000 },
        capabilities: { reasoning: true, tool_call: false, web_search: true, image_input: true, file_input: true },
      },
    ]);
  });

  test("an older backend's four fields give Astra and both Sols the shared metadata", () => {
    const catalog = sanitizeMarsModelCatalog({
      object: "list",
      data: [
        { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: true, reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", default: false, reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "gpt-6-sol", display_name: "GPT 6 Sol", default: false, reasoning_levels: ["low", "high", "xhigh", "max"] },
      ],
    });
    expect(catalog).toEqual(builtinMarsModelCatalog());
  });

  test("the built-ins are only the fallback (the backend's list); the catalog decides what is served", () => {
    expect(builtinMarsModelCatalog().map((model) => [model.id, model.display_name, model.default])).toEqual([
      ["gpt-6-astra", "GPT 6 Astra", true],
      ["gpt-6.1-sol", "GPT 6.1 Sol", false],
      ["gpt-6-sol", "GPT 6 Sol", false],
    ]);
    const body = backendCatalogBody();
    const catalog = sanitizeMarsModelCatalog({ ...body, data: body.data.filter((model) => model.id === "gpt-6-astra" || model.id === "gpt-6-sol") });
    expect(catalog).toEqual(builtinMarsModelCatalog().filter((model) => model.id !== "gpt-6.1-sol"));
  });

  test("takes any catalog model: an id with dots, an id never seen before, a new default", () => {
    const catalog = sanitizeMarsModelCatalog({
      object: "list",
      data: [
        { id: "gpt-6-astra", display_name: "GPT 6 Astra", default: false, family: "OpenAI", reasoning_levels: ["low", "high", "xhigh", "max"] },
        { id: "nova-9.0.1-preview", display_name: "Nova 9.0.1 Preview", default: true, family: "Nova", reasoning_levels: ["low", "high"] },
        { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", default: false, family: "OpenAI", reasoning_levels: ["low", "high", "xhigh", "max"] },
      ],
    })!;
    expect(catalog.map((model) => [model.id, model.display_name])).toEqual([
      ["gpt-6-astra", "GPT 6 Astra"],
      ["nova-9.0.1-preview", "Nova 9.0.1 Preview"],
      ["gpt-6.1-sol", "GPT 6.1 Sol"],
    ]);
    expect(marsDefaultModelId(catalog)).toBe("nova-9.0.1-preview");
    const engine = engineModelsFromCatalog(catalog);
    expect(Object.keys(engine)).toEqual(["gpt-6-astra", "nova-9.0.1-preview", "gpt-6.1-sol"]);
    expect(engine["gpt-6.1-sol"]?.name).toBe("GPT 6.1 Sol");
    expect(engine["nova-9.0.1-preview"]?.family).toBe("Nova");
  });

  test("reasoning summaries follow the catalog: every Codex-route reasoning model, not a fixed pair of ids", () => {
    const catalog = sanitizeMarsModelCatalog(backendCatalogBody())!;
    expect(marsModelWantsReasoningSummary(catalog, "gpt-6-astra")).toBe(true);
    expect(marsModelWantsReasoningSummary(catalog, "gpt-6.1-sol")).toBe(true);
    expect(marsModelWantsReasoningSummary(catalog, "gpt-6-sol")).toBe(true);
    expect(marsModelWantsReasoningSummary(catalog, "meta-muse-spark")).toBe(false);
    expect(marsModelWantsReasoningSummary(catalog, "not-in-catalog")).toBe(false);
    expect(marsModelWantsReasoningSummary(catalog, undefined)).toBe(false);
    const withNew = sanitizeMarsModelCatalog({ data: [{ id: "gpt-7.2-nova", family: "OpenAI", reasoning_levels: ["low", "high"] }] })!;
    expect(marsModelWantsReasoningSummary(withNew, "gpt-7.2-nova")).toBe(true);
  });

  test("keeps exactly one default, and at most 32 models", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `model-${index}`, display_name: `Model ${index}`, default: index >= 3 }));
    const catalog = sanitizeMarsModelCatalog({ data: many });
    expect(catalog).toHaveLength(32);
    expect(catalog?.filter((model) => model.default).map((model) => model.id)).toEqual(["model-3"]);

    const none = sanitizeMarsModelCatalog({ data: [{ id: "first" }, { id: "second" }] });
    expect(none?.map((model) => model.default)).toEqual([true, false]);
  });

  test("an unusable body is no catalog, so the last good one stays", () => {
    for (const body of [null, "list", [], {}, { data: {} }, { data: [] }, { data: [{ id: "" }, { nope: true }] }]) {
      expect(sanitizeMarsModelCatalog(body)).toBeNull();
    }
  });
});

describe("mars model catalog cache", () => {
  test("round-trips through the file, re-sanitized on read, and falls back to the built-ins", async () => {
    const config = await setupConfig();
    expect(await readMarsModelCatalog(config)).toEqual(builtinMarsModelCatalog());

    const catalog = sanitizeMarsModelCatalog(backendCatalogBody())!;
    await writeMarsModelCatalog(config, catalog);
    expect(await readMarsModelCatalog(config)).toEqual(catalog);

    // The file is re-read through the sanitizer: a tampered entry is dropped, not trusted.
    const stored = JSON.parse(await readFile(marsModelCatalogPath(config), "utf8")) as { data: Array<Record<string, unknown>> };
    stored.data.push({ id: "bad id", npm: "evil-sdk" });
    await writeFile(marsModelCatalogPath(config), JSON.stringify(stored));
    expect(await readMarsModelCatalog(config)).toEqual(catalog);

    await writeFile(marsModelCatalogPath(config), "{not json");
    expect(await readMarsModelCatalog(config)).toEqual(builtinMarsModelCatalog());

    await writeMarsModelCatalog(config, catalog);
    await clearMarsModelCatalog(config);
    expect(await readMarsModelCatalog(config)).toEqual(builtinMarsModelCatalog());
  });
});

describe("mars engine models from the catalog", () => {
  const enabled = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
    .filter(([, options]) => options.disabled !== true)
    .map(([key]) => key);
  const disabled = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
    .filter(([, options]) => options.disabled === true)
    .map(([key]) => key);

  test("gives every model its own effort variants and disables the rest", () => {
    const models = engineModelsFromCatalog(sanitizeMarsModelCatalog(backendCatalogBody())!);
    expect(enabled(models["gpt-6-astra"]!)).toEqual(["low", "high", "xhigh", "max"]);
    expect(disabled(models["gpt-6-astra"]!)).toEqual(["none", "minimal", "medium"]);
    for (const id of ["meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]) {
      expect(enabled(models[id]!)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
      expect(disabled(models[id]!)).toEqual(["none", "max"]);
      expect(models[id]!.variants).toMatchObject({ xhigh: { reasoning_effort: "xhigh" } });
    }
  });

  test("labels Muse by family, keeps 1.3 beta and text-only, and never sets attachment", () => {
    const models = engineModelsFromCatalog(sanitizeMarsModelCatalog(backendCatalogBody())!);
    expect(models["meta-muse-spark"]).toMatchObject({
      name: "Meta Muse Spark",
      family: "Meta Muse",
      limit: { context: 158_000, output: 32_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["meta-muse-spark"]!.status).toBeUndefined();
    expect(models["muse-spark-1.3"]).toMatchObject({ status: "beta", modalities: { input: ["text"], output: ["text"] } });
    for (const model of Object.values(models)) expect(model.attachment).toBeUndefined();
    expect(models["gpt-6-astra"]!.family).toBeUndefined();
  });

  test("a deprecated model stays active in the engine, which would otherwise delete it", () => {
    const catalog: MarsModelCatalog = builtinMarsModelCatalog().map((model) => ({ ...model, status: "deprecated" as const }));
    for (const model of Object.values(engineModelsFromCatalog(catalog))) expect(model.status).toBeUndefined();
  });

  test("a model without effort control offers no variant", () => {
    const [model] = sanitizeMarsModelCatalog({ data: [{ id: "plain", display_name: "Plain", reasoning_levels: [], capabilities: { reasoning: false } }] })!;
    const engine = engineModelsFromCatalog([model!]).plain!;
    expect(enabled(engine)).toEqual([]);
    expect(engine.reasoning).toBe(false);
  });
});

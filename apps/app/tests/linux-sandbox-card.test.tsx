import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { MarsWorkspaceBox } from "../src/app/lib/mars-server";
import { LinuxSandboxCard, type LinuxSandboxCardProps } from "../src/react-app/domains/settings/linux-sandbox-card";
import {
  LINUX_SANDBOX_HELP,
  linuxSandboxBackendChoices,
  linuxSandboxBackendSummary,
  linuxSandboxMoving,
  linuxSandboxNextStep,
  linuxSandboxProgress,
  linuxSandboxView,
} from "../src/react-app/domains/settings/linux-sandbox";
import { composerConfigureDestination } from "../src/react-app/domains/settings/library";

function box(overrides: Partial<MarsWorkspaceBox> = {}): MarsWorkspaceBox {
  return {
    mode: null,
    serverDefault: "off",
    on: false,
    source: "default",
    offer: false,
    state: "off",
    runtime: { ok: true, name: "docker", flavor: "desktop", version: "27.1", reason: null },
    backend: {
      id: "docker-desktop", label: "Docker Desktop", version: "27.1", flavor: "desktop", why: "the first that works here, in order: apple > orbstack > colima > docker-desktop",
      alternatives: [
        { id: "apple", label: "Apple container", ok: false, reason: "Apple container needs macOS 26 or later (this is macOS 25)" },
        { id: "docker-desktop", label: "Docker Desktop", ok: true, reason: null },
        { id: "colima", label: "colima", ok: true, reason: null },
      ],
      allowed: null,
    },
    backendSetting: { value: "auto", source: "auto", choices: [{ id: "auto", label: "Automatic" }, { id: "apple", label: "Apple container" }, { id: "docker-desktop", label: "Docker Desktop" }, { id: "native", label: "Off (this computer)" }] },
    image: { ref: "ghcr.io/omnirush-ai/box-base:2026.10.1", stack: "base", present: true, downloading: false },
    progress: null,
    container: null,
    platform: "darwin",
    notice: null,
    error: null,
    ...overrides,
  };
}

const on = { mode: "on", on: true, source: "project" } as const;
const noRuntime = (reason: string, platform: string, alternatives: Array<{ id: string; label: string; ok: boolean; reason: string | null }> = []): Partial<MarsWorkspaceBox> => ({
  ...on,
  platform,
  state: "unavailable",
  runtime: { ok: false, name: null, flavor: null, version: null, reason },
  backend: { id: null, label: null, version: null, flavor: null, why: reason, alternatives, allowed: null },
  container: null,
});

function card(props: Partial<LinuxSandboxCardProps> = {}): string {
  return renderToStaticMarkup(<LinuxSandboxCard box={box()} pending={null} problem={null} notice="" onToggle={() => {}} onRetry={() => {}} onReset={() => {}} onBackend={() => {}} {...props} />);
}

function switchMarkup(markup: string): string {
  const match = markup.match(/<[a-z]+[^>]*role="switch"[^>]*>/);
  if (!match) throw new Error(`no switch in ${markup}`);
  return match[0];
}

describe("Linux sandbox card", () => {
  test("off: the switch, its help, one calm status row, Advanced closed", () => {
    const markup = card();
    expect(markup).toContain("Run commands in a Linux sandbox");
    expect(markup).toContain("Beta");
    expect(markup).toContain(LINUX_SANDBOX_HELP);
    expect(switchMarkup(markup)).toContain('aria-checked="false"');
    expect(markup).toContain('data-tone="off"');
    expect(markup).toContain("Commands run on this computer.");
    expect(markup).toContain("Advanced");
    // Backend and Reset stay inside Advanced (closed).
    expect(markup).not.toContain("Sandbox backend");
    expect(markup).not.toContain("Reset…");
  });

  test("offer: a small prompt with Turn on and Not now, only while off", () => {
    const offer = card({ box: box({ serverDefault: "offer", source: "server", offer: true }) });
    expect(offer).toContain('data-testid="linux-sandbox-offer"');
    expect(offer).toContain("recommends the sandbox");
    expect(offer).toContain("Turn on");
    expect(offer).toContain("Not now");
    expect(card({ box: box({ offer: true }), pending: "on" })).not.toContain("linux-sandbox-offer");
  });

  test("the switch shows the choice at once while the server answers, and is locked meanwhile", () => {
    const turningOn = card({ pending: "on" });
    expect(switchMarkup(turningOn)).toContain('aria-checked="true"');
    expect(switchMarkup(turningOn)).toContain('aria-disabled="true"');
    expect(turningOn).toContain("Turning on…");
    const turningOff = card({ box: box({ ...on, state: "ready" }), pending: "off" });
    expect(switchMarkup(turningOff)).toContain('aria-checked="false"');
    expect(turningOff).toContain("Turning off…");
    // Nothing is claimed before the server answers.
    const loading = card({ box: null });
    expect(switchMarkup(loading)).toContain('aria-disabled="true"');
    expect(loading).toContain("Checking the sandbox…");
  });

  test("downloading: a real bar with MB and percent, or layers, or an indeterminate bar", () => {
    const markup = card({ box: box({ ...on, state: "downloading", image: { ref: "r", stack: "base", present: false, downloading: true }, progress: { bytesDone: 141_000_000, bytesTotal: 346_000_000, layersDone: 3, layersTotal: 7, startedAt: 1 } }) });
    expect(markup).toContain("Downloading the sandbox (once)");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="41"');
    expect(markup).toContain("141 of 346 MB · 41%");
    expect(linuxSandboxProgress({ bytesDone: null, bytesTotal: null, layersDone: 2, layersTotal: 8, startedAt: null })).toEqual({ value: 25, label: "2 of 8 parts · 25%" });
    expect(linuxSandboxProgress(null)).toEqual({ value: null, label: "Starting the download…" });
    expect(linuxSandboxProgress({ bytesDone: 5_400_000, bytesTotal: 71_000_000, layersDone: 0, layersTotal: 1, startedAt: null }).label).toBe("5.4 of 71 MB · 8%");
  });

  test("starting and ready: the backend in plain words; ready is calm (no buttons in the row)", () => {
    expect(linuxSandboxView(box({ ...on, state: "starting" }))).toMatchObject({ tone: "busy", title: "Starting the sandbox…", detail: "Using Docker Desktop 27.1. This takes a few seconds.", action: null });
    const ready = linuxSandboxView(box({ ...on, state: "ready", container: { name: "mars-box-abc", exists: true, running: true } }));
    expect(ready).toMatchObject({ tone: "ready", title: "Ready", detail: "Commands run in a Linux container (Docker Desktop 27.1).", action: null, step: null, errorDetail: null });
    const markup = card({ box: box({ ...on, state: "ready", container: { name: "mars-box-abc", exists: true, running: true } }) });
    expect(switchMarkup(markup)).toContain('aria-checked="true"');
    expect(markup).not.toContain("Try again");
  });

  test("failed: plain words, Try again, the raw error behind Show details", () => {
    const raw = "could not start the sandbox: boxd did not answer on 127.0.0.1:41871 within 20s";
    const view = linuxSandboxView(box({ ...on, state: "failed", error: raw }));
    expect(view).toMatchObject({ tone: "error", title: "The sandbox could not start", detail: "Commands run on this computer for now.", action: { kind: "retry", label: "Try again" }, errorDetail: raw });
    const markup = card({ box: box({ ...on, state: "failed", error: raw }) });
    expect(markup).toContain("Try again");
    expect(markup).toContain("Show details");
    // The raw error is not in the row itself.
    expect(markup).not.toContain("127.0.0.1:41871");
  });

  test("no backend: one next step per OS with a command to copy and Check again", () => {
    const win = linuxSandboxNextStep(box(noRuntime("no sandbox backend found (turn on WSL 2: `wsl --install --no-distribution` as administrator, then `wsl --update` for WSL containers; or Docker Desktop, Podman)", "win32")));
    expect(win).toMatchObject({ title: "Turn on WSL 2", command: "wsl --install --no-distribution" });
    const mac = linuxSandboxNextStep(box(noRuntime("no container runtime found (free: `brew install colima docker && colima start`; also OrbStack, Docker Desktop, Podman; Apple container only when chosen in Settings)", "darwin")));
    expect(mac).toMatchObject({ title: "Install a container app", command: "brew install colima docker && colima start" });
    const ubuntu = linuxSandboxNextStep(box(noRuntime("bwrap: blocked", "linux", [{ id: "bwrap", label: "bubblewrap (no daemon)", ok: false, reason: "unprivileged user namespaces are blocked by AppArmor; one-time admin fix: `sudo mars sandbox enable` (Mars CLI)" }, { id: "docker", label: "Docker", ok: false, reason: "not found" }])));
    expect(ubuntu).toMatchObject({ title: "Allow the sandbox on this computer", command: "sudo mars sandbox enable" });
    expect(linuxSandboxNextStep(box(noRuntime("docker: x", "linux", [{ id: "docker", label: "Docker", ok: false, reason: "Docker refused this user (add it to the docker group: `sudo usermod -aG docker $USER`, then log in again), or use rootless Podman" }])))).toMatchObject({ title: "Let this user run Docker", command: "sudo usermod -aG docker $USER" });
    expect(linuxSandboxNextStep(box(noRuntime("podman: not found", "linux")))).toMatchObject({ title: "Install Podman or Docker", command: "sudo apt install podman" });
    expect(linuxSandboxNextStep(box(noRuntime("x", "win32", [{ id: "docker-desktop", label: "Docker Desktop", ok: false, reason: "Docker is installed but not running (start Docker Desktop, OrbStack or colima)" }])))).toMatchObject({ title: "Start your container app", command: null });

    const markup = card({ box: box(noRuntime("no sandbox backend found (turn on WSL 2: `wsl --install --no-distribution` as administrator)", "win32")) });
    expect(markup).toContain('data-tone="attention"');
    expect(markup).toContain("Turn on WSL 2");
    expect(markup).toContain("wsl --install --no-distribution");
    expect(markup).toContain('aria-label="Copy command"');
    expect(markup).toContain("Check again");
  });

  test("the backend set to Off is one button away from automatic; a project gone native can try again", () => {
    expect(linuxSandboxView(box({ ...on, state: "unavailable", runtime: { ok: false, name: null, flavor: null, version: null, reason: "set to native" }, backendSetting: { value: "native", source: "setting", choices: [] } }))).toMatchObject({ title: "The backend is set to Off", action: { kind: "auto-backend", label: "Use automatic" } });
    expect(linuxSandboxView(box({ ...on, state: "unavailable", notice: "Sandbox off for now: the sandbox did not start in time." }))).toMatchObject({ title: "The sandbox is not running", action: { kind: "retry" }, errorDetail: "the sandbox did not start in time" });
  });

  test("a buildathon project turned off here says it is less reproducible; the event's offer says so too", () => {
    const less = "This buildathon project runs on this computer (sandbox off here), so it is less reproducible. Turn the Linux sandbox on to run it in the box.";
    expect(linuxSandboxView(box({ on: false, mode: "off", source: "project", state: "off", notice: less }))).toMatchObject({ tone: "attention", title: "Off for this project", detail: less });
    const offer = "This buildathon project rebuilds more reliably in the Linux sandbox. Turn it on to run its chats there.";
    expect(linuxSandboxView(box({ on: false, source: "buildathon", offer: true, state: "off", notice: offer }))).toMatchObject({ tone: "attention", title: "Off", detail: offer });
    expect(linuxSandboxView(box({ on: false, source: "default", state: "off", notice: null }))).toMatchObject({ tone: "off", title: "Off", detail: "Commands run on this computer." });
  });

  test("macOS / Windows: a project kept off for its host builds says why (switch off, one click on); on by choice it warns; a box says it is Linux", () => {
    const kept = "This folder has Mac builds (node_modules, .venv) that won't run in the Linux sandbox, so its chats run on this Mac. Turn the sandbox on for this project to use it anyway.";
    const off = box({ on: false, source: "host-builds", state: "off", notice: kept, hostBuilds: { native: true, things: "node_modules, .venv", notice: kept } });
    expect(linuxSandboxView(off)).toMatchObject({ tone: "attention", title: "Off for this project", detail: kept });
    const markup = card({ box: off });
    expect(switchMarkup(markup)).toContain('aria-checked="false"');
    expect(switchMarkup(markup)).not.toContain('aria-disabled="true"');
    expect(markup).toContain("Mac builds (node_modules, .venv)");
    const warning = "This folder has Mac builds (node_modules) that won't run in the Linux sandbox; rebuilding them there replaces them with Linux builds that won't run on this Mac.";
    expect(linuxSandboxView(box({ ...on, mode: "on", source: "project", state: "ready", hostBuilds: { native: false, things: "node_modules", notice: warning } }))).toMatchObject({ tone: "attention", title: "Ready", detail: warning });
    const line = "Chats here run in a Linux sandbox, not on this Mac; turn it off for this project in Settings to run them here.";
    expect(linuxSandboxView(box({ ...on, state: "ready", boxNotice: line }))).toMatchObject({ tone: "ready", title: "Ready", detail: line });
  });

  test("forced by the environment: the switch is locked and says where", () => {
    const markup = card({ box: box({ source: "env" }) });
    expect(switchMarkup(markup)).toContain('aria-disabled="true"');
    expect(markup).toContain("Set by MARS_BOX where the app is launched.");
  });

  test("Advanced: automatic (recommended) first, the backend in use, the others with why not, Reset behind a confirm", () => {
    const value = box({ ...on, state: "ready", container: { name: "mars-box-abc", exists: true, running: true } });
    expect(linuxSandboxBackendChoices(value)[0]).toEqual({ value: "auto", label: "Automatic (recommended)" });
    expect(linuxSandboxBackendSummary(value)).toBe("Using Docker Desktop 27.1, picked automatically.");
    expect(linuxSandboxBackendSummary(box({ backendSetting: { value: "native", source: "setting", choices: [] } }))).toBe("Set to Off: commands run on this computer.");
    expect(linuxSandboxBackendSummary(box({ runtime: null, backend: null }))).toBe("No backend works on this computer yet.");
    const markup = card({ box: value, defaultAdvancedOpen: true });
    expect(markup).toContain('aria-label="Sandbox backend"');
    expect(markup).toContain("Apple container needs macOS 26 or later");
    expect(markup).toContain("colima");
    expect(markup).toContain("Reset…");
    // The confirm dialog is not open until Reset… is pressed.
    expect(markup).not.toContain("Reset the sandbox?");
    // No container yet: nothing to reset.
    expect(card({ box: box({ ...on, state: "starting" }), defaultAdvancedOpen: true })).toContain("Nothing to reset");
  });

  test("errors from the server are plain words with a retry; polling only while it moves", () => {
    const markup = card({ problem: { message: "The sandbox could not be turned on.", retry: () => {} } });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The sandbox could not be turned on.");
    expect(markup).toContain("Try again");
    expect(linuxSandboxMoving(box({ ...on, state: "downloading" }))).toBe(true);
    expect(linuxSandboxMoving(box({ ...on, state: "starting" }))).toBe(true);
    expect(linuxSandboxMoving(box({ ...on, state: "ready" }))).toBe(false);
    expect(linuxSandboxMoving(box({ state: "starting" }))).toBe(false);
  });

  test("reduced motion: spinners and the bar animate only with motion allowed", () => {
    const markup = card({ pending: "on" });
    expect(markup).toContain("motion-safe:animate-spin");
    expect(markup).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
  });

  test("the composer's sandbox chip opens Settings > General at the card", () => {
    expect(composerConfigureDestination("sandbox")).toEqual({ kind: "settings", route: "/settings/general#linux-sandbox" });
  });
});

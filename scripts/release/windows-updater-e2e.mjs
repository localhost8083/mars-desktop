#!/usr/bin/env node
/**
 * Drives a published Windows release's own in-app updater, end to end, on a
 * Windows machine (CI runner): installs v<from> with its NSIS installer, opens
 * it with a DevTools port, and calls the same bridge the Updates page and the
 * required-update screen call (check, download, installAndRestart). Then waits
 * for the installed version to change and checks the app data is still there.
 *
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect 3.4.3 --feed <dir>
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect 3.4.1        (the public Latest feed)
 *   node scripts/release/windows-updater-e2e.mjs --from 3.3.8 --expect none --feed <dir with 3.3.8's latest.yml>
 *
 * --feed serves a directory (latest.yml + installer) on a loopback port and
 * points the app at it with MARS_UPDATER_DEV_FEED_URL, which every
 * release since the updater rewrite honors for loopback URLs only.
 * --expect none: the check must report no update, and nothing may install.
 */
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const REPO = "mars-ai/mars-gui";
const CDP_PORT = 9339;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const from = argValue("--from");
const expect = argValue("--expect");
const feedDir = argValue("--feed");
const workDir = path.resolve(argValue("--work") ?? path.join(process.cwd(), "updater-e2e"));
if (!from || !expect) {
  console.error("Usage: windows-updater-e2e.mjs --from X.Y.Z --expect X.Y.Z|none [--feed dir] [--work dir]");
  process.exit(2);
}
mkdirSync(workDir, { recursive: true });

function log(message, data) {
  console.log(`[e2e] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
}

function installs() {
  const script = "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'mars' } | Select-Object DisplayName,DisplayVersion,UninstallString | ConvertTo-Json -Compress";
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  if (!out) return [];
  const value = JSON.parse(out);
  return Array.isArray(value) ? value : [value];
}

function installFolder(entry) {
  const match = /^"([^"]+)"/.exec(entry.UninstallString ?? "");
  return match ? path.dirname(match[1]) : null;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function serveFeed(directory) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname.slice(1));
      const file = path.join(directory, name);
      log(`feed ${request.method} /${name}`);
      if (!name || name.includes("/") || name.includes("\\") || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-length": statSync(file).size, "content-type": "application/octet-stream" });
      if (request.method === "HEAD") return response.end();
      createReadStream(file).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function cdpTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      waiter(message);
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) waiter({ error: { message: "socket closed" } });
      pending.clear();
    });
    socket.addEventListener("error", () => reject(new Error(`cannot open ${wsUrl}`)));
    socket.addEventListener("open", () => resolve({
      socket,
      async evaluate(expression, timeoutMs = 600_000) {
        nextId += 1;
        const id = nextId;
        const answer = new Promise((done) => pending.set(id, done));
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        const message = await Promise.race([answer, sleep(timeoutMs).then(() => ({ error: { message: "timed out" } }))]);
        if (message.error) throw new Error(message.error.message);
        if (message.result?.exceptionDetails) throw new Error(JSON.stringify(message.result.exceptionDetails));
        return message.result?.result?.value;
      },
    }));
  });
}

async function bridgePage(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const target of (await cdpTargets()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
      try {
        const page = await connect(target.webSocketDebuggerUrl);
        const ready = await page.evaluate("typeof window.__MARS_ELECTRON__?.updater?.check === 'function'", 10_000);
        if (ready) {
          log(`bridge on ${target.url}`);
          return page;
        }
        page.socket.close();
      } catch {
        // Not ready yet.
      }
    }
    await sleep(2_000);
  }
  throw new Error("the app window never exposed the updater bridge");
}

function appProcesses() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq MarsAI.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.startsWith('"MarsAI.exe"')).length;
  } catch {
    return 0;
  }
}

async function waitForProcess(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcesses() > 0) return true;
    await sleep(2_000);
  }
  return false;
}

function stopApp() {
  try {
    execFileSync("taskkill", ["/F", "/T", "/IM", "MarsAI.exe"], { stdio: "ignore" });
  } catch {
    // Not running.
  }
}

async function main() {
  const installer = path.join(workDir, `mars-win-x64-${from}.exe`);
  await download(`https://github.com/${REPO}/releases/download/v${from}/mars-win-x64-${from}.exe`, installer);
  execFileSync(installer, ["/S"], { stdio: "inherit" });
  const before = installs();
  log("installed", before);
  if (before.length !== 1 || before[0].DisplayVersion !== from) throw new Error(`expected one install of ${from}`);
  const folder = installFolder(before[0]);
  const exe = readdirSync(folder).find((name) => name.endsWith(".exe") && !/^Uninstall/i.test(name));
  log("app", { folder, exe });

  // Data the update must keep: a marker in userData (%APPDATA%\ai.marsai.desktop).
  const userData = path.join(process.env.APPDATA, "ai.marsai.desktop");
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, "updater-e2e-marker.txt"), "kept");

  const feed = feedDir ? await serveFeed(path.resolve(feedDir)) : null;
  const env = {
    ...process.env,
    MARS_ELECTRON_REMOTE_DEBUG_PORT: String(CDP_PORT),
    ...(feed ? { MARS_UPDATER_DEV_FEED_URL: feed.url } : {}),
  };
  const output = openSync(path.join(workDir, `app-${from}.log`), "a");
  const child = spawn(path.join(folder, exe), [], { env, detached: true, stdio: ["ignore", output, output] });
  child.unref();

  const page = await bridgePage(240_000);
  const run = (call) => page.evaluate(`window.__MARS_ELECTRON__.updater.${call}`);
  log("getChannel", await run("getChannel()"));
  const checked = await run("check('stable')");
  log("check", checked);

  if (expect === "none") {
    const downloaded = await run("download()");
    log("download", downloaded);
    stopApp();
    feed?.server.close();
    if (checked?.available !== false) throw new Error("the check offered an update");
    if (downloaded?.ok !== false) throw new Error("a download started with no update available");
    const after = installs();
    if (after.length !== 1 || after[0].DisplayVersion !== from) throw new Error("the installed version changed");
    log(`PASS: ${from} finds no update (feed offers ${checked.latestVersion}); download says: ${downloaded.reason}`);
    return;
  }

  if (!checked?.available || checked.latestVersion !== expect) throw new Error(`the check did not offer ${expect}`);
  const downloaded = await run("download()");
  log("download", downloaded);
  if (!downloaded?.ok) throw new Error(`download failed: ${downloaded?.reason}`);
  // The app quits into the installer; the answer may never arrive.
  void page.evaluate("window.__MARS_ELECTRON__.updater.installAndRestart()", 180_000)
    .then((result) => log("installAndRestart", result))
    .catch((error) => log(`installAndRestart: ${error.message}`));

  const deadline = Date.now() + 420_000;
  let after = [];
  while (Date.now() < deadline) {
    after = installs();
    if (after.length === 1 && after[0].DisplayVersion === expect) break;
    await sleep(5_000);
  }
  log("after", after);
  if (after.length !== 1 || after[0].DisplayVersion !== expect) throw new Error(`the install did not reach ${expect}`);
  if (installFolder(after[0]) !== folder) throw new Error(`the update moved the app to ${installFolder(after[0])}`);
  const version = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Item '${path.join(folder, exe)}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
  log("executable version", version);
  if (readFileSync(path.join(userData, "updater-e2e-marker.txt"), "utf8") !== "kept") throw new Error("app data was lost");
  // The updated app relaunches by itself (quitAndInstall forceRunAfter).
  const relaunched = await waitForProcess(120_000);
  log("relaunched", relaunched);
  stopApp();
  feed?.server.close();
  log(`PASS: ${from} updated itself to ${version} in ${folder}, data kept, relaunched=${relaunched}`);
}

main().then(() => process.exit(0), (error) => {
  console.error(`[e2e] FAIL: ${error.message}`);
  stopApp();
  process.exit(1);
});

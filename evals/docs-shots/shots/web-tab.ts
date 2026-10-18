import { waitFor } from "@mars/behaviors";
import { org } from "../seed.ts";
import { webTab } from "../surfaces.ts";
import { shot } from "./shot.ts";

const browser = webTab({ org });

async function waitForMarsWeb(surface: Awaited<ReturnType<typeof browser.load>>): Promise<void> {
  await waitFor(surface, () => (Boolean(window.__marsControl)), {
    timeoutMs: 120_000,
    label: "MarsAI Web booted",
  });
  await waitFor(surface, () => (document.body.innerText.includes("acme-robotics")
    && document.body.innerText.includes("Describe your task")
    && !document.body.innerText.includes("Pulling in the latest messages")), {
    timeoutMs: 120_000,
    label: "MarsAI Web settled on the demo workspace",
  });
}

export const marsWebTab = shot("mars-web-tab", {
  use: browser,
  at: "/",
  steps: [waitForMarsWeb],
  expect: ["acme-robotics", "What do you need done?"],
  never: ["Something went wrong", "Unable to connect", "docs-3959-screenshots"],
  out: "packages/docs/images/mars-web-browser-tab.png",
});

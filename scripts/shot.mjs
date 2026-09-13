#!/usr/bin/env node
/**
 * Screenshot a page with headless Edge/Chrome over the DevTools protocol.
 *
 *   node scripts/shot.mjs <url> <out.png> [waitMs=4000] [width=1600] [height=1400] [clickText] [afterMs]
 *
 * `clickText` clicks the first button whose text contains it (after the first
 * wait), then waits `afterMs`; "A|B" clicks A, waits, then B, waits -- enough
 * to open a tab and run a table.
 *
 * `--screenshot` alone captures before a client-rendered page has fetched
 * anything, and `--virtual-time-budget` never completes while an SSE stream is
 * open. Driving the browser ourselves sidesteps both: load, wait a fixed beat
 * for the fetches, capture the full page.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [
  url = "http://localhost:3000/",
  out = "shot.png",
  waitArg = "4000",
  widthArg = "1600",
  heightArg = "1400",
  clickText = "",
  afterArg = "0",
] = process.argv.slice(2);
const wait = Number(waitArg);
const width = Number(widthArg);
const height = Number(heightArg);

const candidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const bin = candidates.find((p) => existsSync(p));
if (bin === undefined) {
  console.error("no Edge/Chrome found");
  process.exit(1);
}

const port = 9222 + Math.floor(Math.random() * 500);
const browser = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env["TEMP"] ?? "/tmp"}/mercury-shot-profile`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      return await res.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("browser did not open the debugging port");
}

try {
  const [page] = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(wait);

  // "Tab name|Run all" clicks each in turn, waiting `afterMs` after every click.
  for (const text of clickText.split("|").filter((t) => t !== "")) {
    await send("Runtime.evaluate", {
      expression: `(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`,
    });
    await sleep(Number(afterArg));
  }

  const { contentSize } = await send("Page.getLayoutMetrics");
  const fullHeight = Math.min(Math.ceil(contentSize.height), 6000);
  await send("Emulation.setDeviceMetricsOverride", { width, height: fullHeight, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`${out} ${width}x${fullHeight}`);
  ws.close();
} finally {
  browser.kill();
  // On Windows the child tree can outlive kill(); do not let it hold the event loop.
  setTimeout(() => process.exit(0), 200).unref();
}

import { chromium } from "playwright-core";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(), "archivist-panel-startup-"));
const extension = path.join(root, "extension");
await cp("dist", extension, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(root, "browser"), {
  executablePath: process.env.ARCHIVIST_TEST_CHROMIUM || "/usr/bin/chromium", headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const panel = await context.newPage();
  await panel.addInitScript(() => {
    // Neither a dead worker channel nor slow Zotero access may gate hydration.
    chrome.runtime.sendMessage = () => new Promise(() => {});
    chrome.permissions.contains = () => new Promise(() => {});
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = keys => Array.isArray(keys) && keys.includes("queueRuntime") && keys.includes("selectorRules")
      ? get(keys).then(stored => new Promise(resolve => { globalThis.releaseInitialState = () => resolve(stored); })) : get(keys);
  });
  const url = `chrome-extension://${new URL(worker.url()).hostname}/sidepanel/panel.html`;
  for (const save of [false, true]) {
    await panel.goto(url);
    await panel.waitForFunction(() => typeof globalThis.releaseInitialState === "function");
    await panel.evaluate(() => document.querySelector("#add-rule-button").click());
    if (save) {
      await panel.evaluate(() => document.querySelector("#save-rules-button").click());
      await panel.locator("#status").filter({ hasText: "Saved 1 selector rule(s)." }).waitFor();
    }
    await panel.evaluate(() => globalThis.releaseInitialState());
    // Wait until the read/hydration continuation has run, then inspect the form.
    await panel.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    assert.equal(await panel.locator(".selector-rule-item").count(), 1);
    assert.equal(await panel.locator("#save-rules-button").isDisabled(), save);
    assert.match(await panel.locator("#status").textContent(), save ? /Saved 1/ : /Added selector rule/);
  }
  // With no draft, local state still becomes Ready while both remote paths hang.
  await panel.goto(url);
  await panel.waitForFunction(() => typeof globalThis.releaseInitialState === "function");
  await panel.evaluate(() => globalThis.releaseInitialState());
  await panel.locator("#status").filter({ hasText: "Ready." }).waitFor();
  console.log(JSON.stringify({ root, draftsAndSavesSurviveLateHydration: true, readyWithoutWorkerOrZotero: true }));
} finally {
  await context.close();
}

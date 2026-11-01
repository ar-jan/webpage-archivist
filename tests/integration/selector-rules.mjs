import { openNativeSidePanel } from "../test-helpers/native-sidepanel.mjs";
// UI regression test with an isolated Chromium profile and a synthetic HTTP(S)
// page. No Zotero instance or credentials are needed.
import { chromium } from "playwright-core";
import { mkdtemp, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(), "archivist-selector-test-"));
const extension = path.join(root, "extension");
await mkdir(extension);
for (const entry of ["background", "content", "shared", "sidepanel", "zotero", "vendor", "icons", "manifest.json"]) {
  await cp(entry, path.join(extension, entry), { recursive: true });
}
const manifestPath = path.join(extension, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = ["https://selector-fixture.test/*"];
await writeFile(manifestPath, JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(path.join(root, "browser"), {
  executablePath: process.env.ARCHIVIST_TEST_CHROMIUM || "/usr/bin/chromium",
  headless: true,
  viewport: { width: 420, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  await context.route("https://selector-fixture.test/**", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><title>Selector fixture</title><a class="chosen" href="/chosen">Chosen</a><a href="/ignored">Ignored</a>'
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/sidepanel/panel.html`);
  await panel.locator("#status").filter({ hasText: "Ready." }).waitFor();
  const save = panel.getByRole("button", { name: "Save rules", exact: true });
  assert.equal(await save.isDisabled(), true);
  await panel.locator("#selectors-toggle-button").click();
  await panel.locator(".rule-enabled-input").first().uncheck();
  await panel.getByRole("button", { name: "Add Rule", exact: true }).click();
  assert.equal(await save.isEnabled(), true);
  const custom = panel.locator(".selector-rule-item").last();
  await custom.locator(".rule-heading-toggle").click();
  await custom.locator(".rule-name-input").fill("Chosen links");
  await custom.locator(".rule-selector-input").fill("a.chosen");

  // Even a non-responsive worker message channel must not block local rule saves.
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.selectorMessages = 0;
    chrome.runtime.sendMessage = (...args) => {
      if (args[0].type === "SET_SELECTOR_RULES") {
        globalThis.selectorMessages++;
        return new Promise(() => {});
      }
      return send(...args);
    };
  });
  // Exercise explicit Save and verify that it persisted directly to storage.
  await save.click();
  await panel.locator("#status").filter({ hasText: "Saved 3 selector rule(s)." }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await panel.evaluate(() => globalThis.selectorMessages), 0);
  await panel.reload();
  await panel.locator("#status").filter({ hasText: "Ready." }).waitFor();
  const stored = await panel.evaluate(() => chrome.storage.local.get("selectorRules"));
  assert.equal(stored.selectorRules.at(-1).cssSelector, "a.chosen");
  await panel.locator("#selectors-toggle-button").click();
  await custom.locator(".rule-heading-toggle").click();
  await custom.locator(".rule-name-input").fill("Updated chosen links");
  assert.equal(await save.isEnabled(), true);
  await panel.evaluate(() => chrome.storage.local.set({ collectorSettings: { autoScrollEnabled: false } }));

  const fixture = await context.newPage();
  await fixture.goto("https://selector-fixture.test/");
  async function collectFromFixture() {
    await fixture.bringToFront();
    // A real side panel does not replace the active content tab. Trigger its
    // click without focusing this tab-hosted test panel. Host access is pregranted.
    await panel.evaluate(() => document.querySelector("#collect-links-button").click());
  }
  await collectFromFixture();
  await panel.locator("#status").filter({ hasText: "Collected 1 link(s)." }).waitFor();
  assert.equal(await save.isDisabled(), true);
  const collected = await panel.evaluate(() => chrome.storage.local.get(["selectorRules", "collectedLinks"]));
  assert.equal(collected.selectorRules.at(-1).name, "Updated chosen links");
  assert.deepEqual(collected.collectedLinks.map(link => link.url), ["https://selector-fixture.test/chosen"]);

  // Invalid drafts must remain editable and must not trigger collection.
  await custom.locator(".rule-heading-toggle").click();
  await custom.locator(".rule-selector-input").fill("");
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.collectionRequests = 0;
    chrome.runtime.sendMessage = (...args) => {
      if (args[0].type === "COLLECT_LINKS") globalThis.collectionRequests++;
      return send(...args);
    };
  });
  await collectFromFixture();
  await panel.locator("#status").filter({ hasText: "must include a CSS selector" }).waitFor();
  assert.equal(await panel.evaluate(() => globalThis.collectionRequests), 0);
  assert.equal(await save.isEnabled(), true);

  // A failed save must not silently collect using older, persisted selectors.
  await custom.locator(".rule-selector-input").fill("a.chosen");
  await panel.evaluate(() => {
    globalThis.originalStorageSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = () => Promise.reject(new Error("Fixture storage failure"));
  });
  await collectFromFixture();
  await panel.locator("#status").filter({ hasText: "Failed to save selector rules." }).waitFor();
  assert.equal(await panel.evaluate(() => globalThis.collectionRequests), 0);
  assert.equal(await save.isEnabled(), true);
  assert.equal(await custom.locator(".rule-selector-input").inputValue(), "a.chosen");
  // Reproduce a save that never settles, then retry and deliver a late old reply.
  await panel.evaluate(() => {
    chrome.storage.local.set = () => new Promise(resolve => { globalThis.finishLateSave = resolve; });
  });
  await save.click();
  await panel.locator("#status").filter({ hasText: "Saving selector rules timed out." }).waitFor();
  assert.equal(await save.isEnabled(), true);
  assert.equal(await custom.locator(".rule-selector-input").inputValue(), "a.chosen");
  await custom.locator(".rule-name-input").fill("Retried rule");
  await panel.evaluate(() => { chrome.storage.local.set = globalThis.originalStorageSet; });
  await save.click();
  await panel.locator("#status").filter({ hasText: "Saved 3 selector rule(s)." }).waitFor();
  await panel.evaluate(() => globalThis.finishLateSave());
  assert.equal(await custom.locator(".rule-heading-title").innerText(), "Retried rule");
  assert.equal(await save.isDisabled(), true);
  // Exercise the genuine native side panel, including after worker shutdown.
  const native = await openNativeSidePanel(context, panel);
  await native.evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    while (document.querySelector("#status").textContent !== "Ready.") {
      if (Date.now() > deadline) throw new Error("Native panel did not initialize");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })()`);
  const nativeContexts = await panel.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }));
  assert.equal(nativeContexts.length, 1);
  await native.stopWorker();
  const nativeResult = await native.evaluate(`(async () => {
    chrome.runtime.sendMessage = () => new Promise(() => {});
    document.querySelector("#add-rule-button").click();
    document.querySelector("#save-rules-button").click();
    const deadline = Date.now() + 6000;
    while (document.querySelector("#save-rules-button").textContent === "Saving…") {
      if (Date.now() > deadline) throw new Error("Native save did not complete");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { status: document.querySelector("#status").textContent,
      rules: (await chrome.storage.local.get("selectorRules")).selectorRules.length };
  })()`);
  assert.equal(nativeResult.status, "Saved 4 selector rule(s).");
  assert.equal(nativeResult.rules, 4);
  assert.deepEqual(errors, []);
  await panel.screenshot({ path: path.join(root, "selector-rules.png"), fullPage: true });
  console.log(JSON.stringify({ root, savedRules: 3, collectedLinks: 1, validationAndSaveFailuresBlockedCollection: true, hungSaveRecovered: true, nativePanelSavedWithoutWorker: true }));
} finally {
  await context.close();
}

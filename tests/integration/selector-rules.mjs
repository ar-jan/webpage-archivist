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

  // Exercise explicit Save and verify that it really persisted through the worker.
  await save.click();
  await panel.locator("#status").filter({ hasText: "Saved 3 selector rule(s)." }).waitFor();
  assert.equal(await save.isDisabled(), true);
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
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => args[0].type === "SET_SELECTOR_RULES"
      ? Promise.resolve({ ok: false, error: { message: "Fixture save failed" } })
      : send(...args);
  });
  await collectFromFixture();
  await panel.locator("#status").filter({ hasText: "Fixture save failed" }).waitFor();
  assert.equal(await panel.evaluate(() => globalThis.collectionRequests), 0);
  assert.equal(await save.isEnabled(), true);
  assert.equal(await custom.locator(".rule-selector-input").inputValue(), "a.chosen");
  assert.deepEqual(errors, []);
  await panel.screenshot({ path: path.join(root, "selector-rules.png"), fullPage: true });
  console.log(JSON.stringify({ root, savedRules: 3, collectedLinks: 1, validationAndSaveFailuresBlockedCollection: true }));
} finally {
  await context.close();
}

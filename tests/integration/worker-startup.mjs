// Verify a checkout without node_modules/dist, including reload and real capture.
import { chromium } from "playwright-core";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { copyExtension } from "../test-helpers/extension-copy.mjs";

const root = await mkdtemp(path.join(tmpdir(), "archivist-worker-test-"));
const extension = path.join(root, "extension");
await copyExtension(extension);
for (const file of ["background/service-worker.js", "vendor/md5.js", "vendor/single-file-hooks.js", "content/snapshot.bundle.js"]) {
  await access(path.join(extension, file));
}
const manifestPath = path.join(extension, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = ["https://startup-fixture.test/*"];
await writeFile(manifestPath, JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(path.join(root, "browser"), {
  executablePath: process.env.ARCHIVIST_TEST_CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  await context.route("https://startup-fixture.test/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/style.css") return route.fulfill({ contentType: "text/css", body: "h1 { color: rgb(12, 34, 56); }" });
    if (pathname === "/image.svg") return route.fulfill({ contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>' });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html><head><title>Checkout fixture</title><link rel="icon" href="/image.svg"><link rel="stylesheet" href="/style.css"></head><body><h1>Archived café 🌍</h1><img src="/image.svg"><p id="dynamic">Original</p><script>document.querySelector("#dynamic").textContent="Live checkout DOM";</script></body></html>' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
  const id = new URL(worker.url()).hostname;
  const extensions = await context.newPage();
  await extensions.goto("chrome://extensions");
  await extensions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  const panel = await context.newPage();
  const panelUrl = `chrome-extension://${id}/sidepanel/panel.html`;

  // Initial registration and an explicit developer-mode reload must both work.
  for (const reload of [false, true]) {
    if (reload) {
      await panel.goto("about:blank");
      await extensions.evaluate(id => chrome.developerPrivate.reload(id, { failQuietly: true }), id);
    }
    // Brave can acknowledge Reload before the extension has been re-enabled.
    await extensions.waitForFunction(async id => {
      const info = (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })).find(item => item.id === id);
      return info?.state === "ENABLED" && info.views.some(view =>
        view.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" && view.renderProcessId !== -1);
    }, id, { timeout: 10000 });
    await panel.goto(panelUrl);
    await panel.locator("#status").filter({ hasText: "Ready." }).waitFor({ timeout: 10000 });
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_QUEUE" }));
    assert.equal(response.ok, true);
    if (reload) {
      assert.equal(await panel.evaluate(async () => (await chrome.storage.local.get("installationMarker")).installationMarker), "root-checkout");
    } else {
      await panel.evaluate(() => chrome.storage.local.set({ installationMarker: "root-checkout" }));
    }
    const info = await extensions.evaluate(async id =>
      (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })).find(item => item.id === id), id);
    assert.deepEqual(info.manifestErrors, []);
    assert.deepEqual(info.runtimeErrors, []);
    assert.ok(info.views.some(view => view.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" && view.renderProcessId !== -1));
  }

  const retired = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "COLLECT_LINKS" }));
  assert.equal(retired.error.code, "BAD_REQUEST");
  // Startup alone missed absent snapshot bundles in the previous vendoring fix.
  const fixture = await context.newPage();
  await fixture.goto("https://startup-fixture.test/");
  const snapshot = await panel.evaluate(async () => {
    const { captureSnapshot } = await import(chrome.runtime.getURL("background/snapshot-capture.js"));
    const { default: SparkMD5 } = await import(chrome.runtime.getURL("vendor/md5.js"));
    const [tab] = await chrome.tabs.query({ url: "https://startup-fixture.test/" });
    const result = await captureSnapshot({ tabId: tab.id, captureId: "checkout-fixture", timeoutMs: 20000 });
    return { html: new TextDecoder().decode(result.bytes), md5: SparkMD5.ArrayBuffer.hash(result.bytes), warnings: result.warnings };
  });
  assert.match(snapshot.html, /Live checkout DOM/);
  assert.match(snapshot.html, /Archived café 🌍/);
  assert.match(snapshot.html, /data:image\/svg\+xml/);
  assert.match(snapshot.html, /12,\s*34,\s*56/);
  // SingleFile may leave empty script elements, but no script code or URL.
  assert.deepEqual(await panel.evaluate(html =>
    [...new DOMParser().parseFromString(html, "text/html").scripts]
      .filter(script => script.src || script.textContent.trim()).map(script => script.outerHTML), snapshot.html), []);
  assert.equal(snapshot.md5, createHash("md5").update(snapshot.html).digest("hex"));
  assert.deepEqual(snapshot.warnings, []);
  console.log(JSON.stringify({ root, checkoutStartup: true, reloadPreservesStorage: true, workerCommands: true,
    retiredRouteRejected: true, snapshotCapture: true, checksum: true }));

} finally {
  await context.close();
}

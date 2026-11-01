// Verify the complete built artifact, including explicit browser reload.
import { chromium } from "playwright-core";
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(), "archivist-worker-test-"));
const extension = path.join(root, "extension");
await cp("dist", extension, { recursive: true });
for (const file of ["background/service-worker.js", "vendor/single-file-hooks.js", "content/snapshot.bundle.js"]) {
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
    const info = await extensions.evaluate(async id =>
      (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })).find(item => item.id === id), id);
    assert.deepEqual(info.manifestErrors, []);
    assert.deepEqual(info.runtimeErrors, []);
    assert.ok(info.views.some(view => view.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" && view.renderProcessId !== -1));
  }

  const retired = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "COLLECT_LINKS" }));
  assert.equal(retired.error.code, "BAD_REQUEST");
  console.log(JSON.stringify({ root, completeBuildStartup: true, reload: true, workerCommands: true, retiredRouteRejected: true }));

} finally {
  await context.close();
}

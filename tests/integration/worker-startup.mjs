// Deliberately exclude ignored build outputs: module tests and earlier browser
// tests built/copied them first, hiding broken startup in a fresh checkout.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(), "archivist-worker-test-"));
const extension = path.join(root, "extension");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0").filter(file => /^(background|content|shared|sidepanel|zotero|vendor|icons)\//.test(file) || file === "manifest.json");
for (const file of new Set(files)) {
  const target = path.join(extension, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(file, target);
}
await access(path.join(extension, "vendor/md5.js"));
for (const file of ["vendor/single-file-hooks.js", "content/snapshot.bundle.js"]) {
  await assert.rejects(access(path.join(extension, file)), { code: "ENOENT" });
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
    const response = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_PANEL_STATE" }));
    assert.equal(response.ok, true);
    const info = await extensions.evaluate(async id =>
      (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })).find(item => item.id === id), id);
    assert.deepEqual(info.manifestErrors, []);
    assert.deepEqual(info.runtimeErrors, []);
    assert.ok(info.views.some(view => view.type === "EXTENSION_SERVICE_WORKER_BACKGROUND" && view.renderProcessId !== -1));
  }

  // Actual Chrome injection errors for absent capture bundles must be actionable.
  await context.route("https://startup-fixture.test/**", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Startup fixture</title><p>Capture me</p>"
  }));
  const fixture = await context.newPage();
  await fixture.goto("https://startup-fixture.test/");
  const failure = await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://startup-fixture.test/*" });
    const { captureSnapshot } = await import(chrome.runtime.getURL("background/snapshot-capture.js"));
    try {
      await captureSnapshot({ tabId: tab.id, captureId: "missing-build-test" });
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert.match(failure, /Snapshot build file is missing \(vendor\/single-file-hooks.js\)/);
  assert.match(failure, /npm ci and npm run build/);
  console.log(JSON.stringify({ root, sourceOnlyStartup: true, reload: true, workerCommands: true, missingCaptureBuildExplained: true }));
} finally {
  await context.close();
}

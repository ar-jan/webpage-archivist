// Opt-in integration test. Requires a disposable Zotero profile with local API
// enabled on port 23129 and its test-only localAPIKeys.json. Never use a real profile.
import { chromium } from "playwright-core";
import { mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const profile = process.env.ARCHIVIST_TEST_ZOTERO_PROFILE;
assert.ok(profile && path.resolve(profile).startsWith(path.join(tmpdir(), "archivist-zotero-test-")), "Provide a disposable /tmp/archivist-zotero-test-*/profile only");
const testKey = JSON.parse(await readFile(path.join(profile, "localAPIKeys.json"), "utf8")).keys[0].key;
const root = await mkdtemp(path.join(tmpdir(), "archivist-chromium-test-"));
const extension = path.join(root, "extension");
await cp("dist", extension, { recursive: true });
await cp("background/save-job-repo.js", path.join(extension, "background/save-job-repo.js"));
// Test-only copy binds every API request to the disposable server.
for (const file of ["zotero/local-client.js", "background/service-worker.js"]) {
  const target = path.join(extension, file);
  await writeFile(target, (await readFile(target, "utf8")).replaceAll("23119", "23129"));
}
const manifestPath = path.join(extension, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(manifestPath, JSON.stringify(manifest));

const fixture = http.createServer((req, res) => {
  if (req.url === "/private" && !req.headers.cookie?.includes("fixture_session=allowed")) {
    res.writeHead(401); res.end("Sign in required"); return;
  }
  if (req.url === "/style.css") { res.writeHead(200, { "Content-Type": "text/css" }); res.end("body { color: rgb(12, 34, 56); } .asset { width: 32px; height: 32px; }"); return; }
  if (req.url === "/image.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>'); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Archivist ${req.url} fixture</title><link rel="stylesheet" href="/style.css"></head><body><h1>Archived café 🌍 ${req.url}</h1><img class="asset" src="/image.svg"><p id="dynamic">Original</p><script>document.querySelector('#dynamic').textContent='Live authenticated DOM';</script></body></html>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(path.join(root, "browser"), {
    executablePath: process.env.ARCHIVIST_TEST_CHROMIUM || "/usr/bin/chromium", headless: true,
    viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const errors = [];
  worker.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await context.addCookies([{ name: "fixture_session", value: "allowed", url: fixtureOrigin }]);
  const panel = await context.newPage();
  panel.on("pageerror", error => errors.push(error.message));
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/panel.html`);
  await panel.evaluate(async key => {
    const { createLocalClient } = await import(chrome.runtime.getURL("zotero/local-client.js"));
    const { saveLocalAuthorization } = await import(chrome.runtime.getURL("zotero/local-settings.js"));
    const health = await createLocalClient().health();
    await saveLocalAuthorization(health.serverID, { key, remember: true });
  }, testKey);
  await panel.reload();
  await panel.waitForFunction(() => document.querySelector("#zotero-destination-select").options[0]?.textContent === "My Library");
  const authored = await panel.evaluate(async origin => {
    return chrome.runtime.sendMessage({ type: "AUTHOR_QUEUE_FROM_SELECTION", payload: { links: ["/public", "/private"].map((suffix, i) => ({ id: `fixture-${i}`, url: origin + suffix, title: suffix, selected: true })) } });
  }, fixtureOrigin);
  assert.equal(authored.ok, true, JSON.stringify(authored));
  await panel.evaluate(async () => {
    const { setQueueSettingsAction } = await import(chrome.runtime.getURL("sidepanel/actions.js"));
    await setQueueSettingsAction({ interItemDelayMs: 0, interItemDelayJitterMs: 0 });
  });
  const started = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "START_QUEUE" }));
  assert.equal(started.ok, true, JSON.stringify(started));
  let state;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    state = await panel.evaluate(() => chrome.storage.local.get(["queueItems", "providerDiagnostics"]));
    if (state.queueItems?.length === 2 && state.queueItems.every(item => ["archived", "failed", "needs_review"].includes(item.status))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.deepEqual(state.queueItems.map(item => ({ status: item.status, error: item.lastError })), [{ status: "archived", error: undefined }, { status: "archived", error: undefined }]);
  const jobs = await panel.evaluate(async () => {
    const { createSaveJobRepo } = await import(chrome.runtime.getURL("background/save-job-repo.js"));
    const repo = createSaveJobRepo();
    const { queueItems } = await chrome.storage.local.get("queueItems");
    return Promise.all(queueItems.map(item => repo.get(item.id)));
  });
  for (const [index, job] of jobs.entries()) {
    const snapshotPath = path.join(path.dirname(profile), "data", "storage", job.attachmentKey, "snapshot.html");
    const html = await readFile(snapshotPath, "utf8");
    assert.ok(html.includes("Live authenticated DOM"));
    assert.ok(html.includes("café 🌍"));
    assert.match(html, /data:image\/svg\+xml/);
    assert.equal(job.phase, "completed");
    const offline = await context.newPage();
    await context.setOffline(true);
    await offline.goto(`file://${snapshotPath}`);
    assert.match(await offline.locator("h1").innerText(), index === 0 ? /public/ : /private/);
    assert.equal(await offline.evaluate(() => getComputedStyle(document.body).color), "rgb(12, 34, 56)");
    assert.equal(await offline.locator("img").evaluate(img => img.complete && img.naturalWidth > 0), true);
    await context.setOffline(false);
    await offline.close();
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  await panel.screenshot({ path: path.join(root, "panel.png"), fullPage: true });
  console.log(JSON.stringify({ root, statuses: state.queueItems.map(i => i.status), warnings: state.queueItems.map(i => i.warnings), browserErrors: errors, version: state.providerDiagnostics.clientVersion }));
} finally {
  await context?.close();
  await new Promise(resolve => fixture.close(resolve));
}

import test from "node:test";
import assert from "node:assert/strict";
import { collectLinksFromTab } from "../shared/link-collection.js";

const tab = { id: 7, url: "https://example.com/" };
const link = { id: "anchors-1", url: "https://iana.org/help/example-domains", title: "Learn more" };

test("collects from the captured tab/document without worker or content messaging", async () => {
  const harness = createHarness();
  const result = await collectLinksFromTab(tab, harness.options);
  assert.equal(result.ok, true);
  assert.equal(result.collectedCount, 1);
  assert.equal(result.links[0].url, link.url);
  assert.deepEqual(harness.saved[0].collectedLinks, result.links);
  assert.deepEqual(harness.scripts[0].target, { tabId: 7, frameIds: [0] });
  assert.deepEqual(harness.scripts[1].target, { tabId: 7, documentIds: ["document-7"] });
  assert.equal(harness.scripts[1].args[1], tab.url);
  assert.equal(harness.scripts[1].args[2].rules[0].cssSelector, "a[href]");
});

test("missing site access prevents injection and persistence", async () => {
  const harness = createHarness();
  harness.chrome.permissions.contains = async () => false;
  const result = await collectLinksFromTab(tab, harness.options);
  assert.equal(result.error.code, "MISSING_HOST_PERMISSION");
  assert.equal(harness.scripts.length, 0);
  assert.equal(harness.saved.length, 0);
});

test("a hung collection times out, cancels its run, and ignores a late reply after retry", async () => {
  const harness = createHarness();
  const execute = harness.chrome.scripting.executeScript;
  let finishLate;
  let lateRequest;
  harness.chrome.scripting.executeScript = request => {
    if (request.args?.length === 3) {
      lateRequest = request;
      return new Promise(resolve => { finishLate = resolve; });
    }
    return execute(request);
  };
  const result = await collectLinksFromTab(tab, harness.options);
  assert.match(result.error.message, /Reading page links timed out/);
  assert.equal(harness.saved.length, 0);
  const cancellation = harness.scripts.at(-1);
  assert.deepEqual(cancellation.target, lateRequest.target);
  assert.deepEqual(cancellation.args, [lateRequest.args[0]]);

  harness.chrome.scripting.executeScript = execute;
  assert.equal((await collectLinksFromTab(tab, harness.options)).ok, true);
  finishLate([{ documentId: "document-7", result: { links: [], url: tab.url } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].collectedLinks[0].url, link.url);
});

for (const stage of ["settings", "injection", "storage"]) {
  test(`a hung ${stage} operation reports a specific timeout`, async () => {
    const harness = createHarness();
    const never = () => new Promise(() => {});
    if (stage === "settings") harness.chrome.storage.local.get = never;
    if (stage === "injection") harness.chrome.scripting.executeScript = never;
    if (stage === "storage") harness.chrome.storage.local.set = never;
    const result = await collectLinksFromTab(tab, harness.options);
    const label = { settings: "Reading collection settings", injection: "Loading the page collector", storage: "Saving collected links" }[stage];
    assert.equal(result.error.message, `${label} timed out. Try Collect Links again.`);
    assert.equal(harness.saved.length, 0);
  });
}

test("navigation during collection preserves the previous links", async () => {
  const harness = createHarness();
  harness.chrome.tabs.get = async () => ({ ...tab, url: "https://example.com/changed" });
  const result = await collectLinksFromTab(tab, harness.options);
  assert.match(result.error.message, /page changed during collection/);
  assert.equal(harness.saved.length, 0);
});

test("collector failures remain actionable and preserve previous links", async () => {
  const harness = createHarness();
  harness.chrome.scripting.executeScript = async () => { throw new Error("Cannot access contents of the page."); };
  const result = await collectLinksFromTab(tab, harness.options);
  assert.equal(result.error.code, "COLLECTOR_ERROR");
  assert.match(result.error.message, /Cannot access contents/);
  assert.equal(harness.saved.length, 0);
});

function createHarness() {
  const saved = [];
  const scripts = [];
  const chrome = {
    // No runtime.sendMessage, tabs.query, tabs.sendMessage, or Zotero client.
    permissions: { contains: async () => true },
    storage: { local: {
      get: async () => ({ collectorSettings: { autoScrollEnabled: false } }),
      set: async value => { saved.push(value); }
    } },
    tabs: { get: async id => { assert.equal(id, tab.id); return tab; } },
    scripting: { executeScript: async request => {
      scripts.push(request);
      if (request.files) return [{ frameId: 0, documentId: "document-7" }];
      if (request.args.length === 1) return [];
      return [{ frameId: 0, documentId: "document-7", result: { links: [link], url: tab.url } }];
    } }
  };
  return { chrome, saved, scripts, options: { chromeImpl: chrome, operationTimeoutMs: 20, collectionTimeoutMs: 20 } };
}

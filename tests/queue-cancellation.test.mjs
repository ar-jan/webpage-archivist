import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createQueueEngine } from "../background/queue-engine.js";
import { createSaveJobRepo } from "../background/save-job-repo.js";
import { createLocalProvider } from "../zotero/provider-local.js";

test("Clear waits for an aborted provider's outstanding storage write before deleting its job", async t => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: { get: async () => ({ status: "complete" }), remove: async () => {} },
    alarms: { create: async () => {}, clear: async () => {} }
  };
  t.after(() => { globalThis.chrome = previousChrome; });
  let runtime = { status: "running", activeQueueItemId: "q1", activeTabId: 1 };
  let items = [{ id: "q1", status: "opening_tab", url: "https://example.com", attempts: 1 }];
  const jobs = createSaveJobRepo({ indexedDBImpl: new IDBFactory() });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const provider = createLocalProvider({
    jobs: { ...jobs, capture: async (...args) => { entered(); await gate; return jobs.capture(...args); } },
    client: { health: async () => ({ serverID: "server" }), request: async () => ({ data: [] }) },
    getSettings: async () => ({ auth: { serverID: "server", key: "key", remember: true },
      destination: { serverID: "server", libraryPath: "/users/0" } }),
    capture: async () => ({ url: "https://example.com", title: "Example",
      bytes: new TextEncoder().encode("<html>Example</html>").buffer })
  });
  const engine = createQueueEngine({
    getQueueRuntime: async () => structuredClone(runtime), saveQueueRuntime: async value => { runtime = value; },
    getQueueItems: async () => structuredClone(items), saveQueueItems: async value => { items = value; },
    saveQueueItemWithProvider: input => provider.saveWebPageWithSnapshot(input)
  });
  void engine.runQueueEngineSoon("test");
  await started;
  engine.cancelActiveSave();
  runtime = { status: "idle", activeQueueItemId: null, activeTabId: null };
  items = [];
  let idle = false;
  const clearing = engine.waitForIdle().then(async () => { idle = true; await jobs.cleanup([]); });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(idle, false, "an abort request must not pretend the provider has settled");
  } finally {
    release();
    await clearing;
  }
  assert.equal(await jobs.get("q1"), undefined, "a delayed capture must not resurrect a cleared job");
});

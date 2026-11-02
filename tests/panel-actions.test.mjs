import test from "node:test";
import assert from "node:assert/strict";
import { getPanelStateAction, setCollectedLinksAction, setQueueSettingsAction, sendRuntimeMessage } from "../sidepanel/actions.js";

test("panel reads, selection and settings use local storage without a worker or network", async t => {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  const stored = {};
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(stored),
    set: async values => { Object.assign(stored, structuredClone(values)); }
  } } };
  assert.equal((await getPanelStateAction()).selectorRules[0].cssSelector, "a[href]");
  assert.deepEqual(stored, {}, "hydration must not write defaults over concurrent edits");
  const links = await setCollectedLinksAction([{ url: "https://example.com/", selected: false }]);
  assert.deepEqual(stored.collectedLinks, links.links);
  const settings = await setQueueSettingsAction({ interItemDelayMs: 1000, interItemDelayJitterMs: 0 });
  assert.deepEqual(stored.queueSettings, settings.queueSettings);
});

test("unresponsive and rejected queue commands report failures without retrying mutations", async t => {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  let calls = 0;
  globalThis.chrome = { runtime: { sendMessage: () => { calls++; return new Promise(() => {}); } } };
  const timedOut = await sendRuntimeMessage("START_QUEUE", undefined, { timeoutMs: 10 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error.message, /command may still complete; check queue status/);
  assert.equal(calls, 1);
  globalThis.chrome.runtime.sendMessage = async () => { throw new Error("Receiving end does not exist."); };
  assert.equal((await sendRuntimeMessage("STOP_QUEUE")).ok, false);
});

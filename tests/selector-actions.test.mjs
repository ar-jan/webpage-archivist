import test from "node:test";
import assert from "node:assert/strict";
import { setSelectorRulesAction } from "../sidepanel/actions.js";
import { STORAGE_KEYS } from "../shared/protocol.js";

function storageHarness(t, set) {
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: { sendMessage: () => assert.fail("Saving local rules must not depend on worker messaging") },
    storage: { local: { set } }
  };
  t.after(() => { globalThis.chrome = previous; });
}

test("selector action persists normalized rules directly and waits for storage completion", async t => {
  let finish;
  let written;
  storageHarness(t, values => {
    written = values;
    return new Promise(resolve => { finish = resolve; });
  });
  let completed = false;
  const saving = setSelectorRulesAction([{ id: "custom", cssSelector: " a.article ", name: " Articles " }])
    .then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(written[STORAGE_KEYS.SELECTOR_RULES][0].cssSelector, "a.article");
  finish();
  const result = await saving;
  assert.equal(result.ok, true);
  assert.deepEqual(result.selectorRules, written[STORAGE_KEYS.SELECTOR_RULES]);
});

test("selector action does not overwrite persisted rules with an invalid draft", async t => {
  storageHarness(t, () => assert.fail("Must not write invalid rules"));
  for (const rules of [null, [], [{ id: "empty", cssSelector: "" }], [
    { id: "duplicate", cssSelector: "a" }, { id: "duplicate", cssSelector: "p" }
  ]]) {
    assert.equal((await setSelectorRulesAction(rules)).ok, false);
  }
});

test("selector action reports storage failures instead of confirming a save", async t => {
  storageHarness(t, async () => { throw new Error("Storage unavailable"); });
  await assert.rejects(setSelectorRulesAction([{ id: "custom", cssSelector: "a" }]), /Storage unavailable/);
});

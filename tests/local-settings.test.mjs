import test from "node:test";
import assert from "node:assert/strict";
import { saveLocalAuthorization, getLocalSettings, saveLocalDestination, forgetLocalAuthorization } from "../zotero/local-settings.js";

test("authorization requires persistent consent, restricts storage, and resets destinations on server change", async t => {
  const previous = globalThis.chrome;
  const state = {};
  const access = [];
  globalThis.chrome = { storage: { local: {
    get: async () => structuredClone(state), set: async values => Object.assign(state, values),
    remove: async key => { delete state[key]; }, setAccessLevel: async value => access.push(value)
  } } };
  t.after(() => { globalThis.chrome = previous; });
  await assert.rejects(saveLocalAuthorization("one", { key: "fixture-key", remember: false }), /Always Allow/);
  assert.deepEqual(state, {});
  await saveLocalAuthorization("one", { key: "fixture-key", remember: true });
  assert.deepEqual(access, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  await saveLocalDestination({ libraryPath: "/groups/123", collectionKey: "ABCDEFGH", label: "Chosen" }, "one");
  await saveLocalAuthorization("one", { key: "replacement-key", remember: true });
  assert.equal((await getLocalSettings()).destination.libraryPath, "/groups/123");
  await saveLocalAuthorization("two", { key: "other-key", remember: true });
  assert.equal((await getLocalSettings()).destination.libraryPath, "/users/0");
  await forgetLocalAuthorization();
  assert.equal((await getLocalSettings()).auth, null);
});

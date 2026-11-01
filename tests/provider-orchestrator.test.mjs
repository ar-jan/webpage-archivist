import test from "node:test";
import assert from "node:assert/strict";
import { createProviderOrchestrator } from "../background/provider-orchestrator.js";
function harness(overrides = {}) {
  const diagnostics = [];
  const orchestrator = createProviderOrchestrator({
    saveProviderDiagnostics: async value => diagnostics.push(value), hasPermission: async () => true,
    client: { health: async () => ({ serverID: "test", version: "10.0.6" }), request: async () => ({ data: [] }) },
    getSettings: async () => ({ auth: { serverID: "test", key: "test-key", remember: true },
      destination: { serverID: "test", libraryPath: "/users/0", label: "My Library" } }),
    provider: { mode: "local_zotero", saveWebPageWithSnapshot: async () => ({ ok: true, parentKey: "ABCDEFGH", warnings: ["Missing resource"] }) },
    ...overrides
  });
  return { orchestrator, diagnostics };
}
test("local provider diagnostics require permission, matching authorization and a valid destination", async () => {
  const h = harness();
  const diagnostics = await h.orchestrator.refreshProviderDiagnostics();
  assert.equal(diagnostics.destinationReady, true);
  const missing = harness({ hasPermission: async () => false });
  assert.equal((await missing.orchestrator.refreshProviderDiagnostics()).destinationReady, false);
  const wrong = harness({ getSettings: async () => ({ auth: { serverID: "different", key: "test" } }) });
  assert.equal((await wrong.orchestrator.refreshProviderDiagnostics()).authorized, false);
});
test("orchestrator preserves provider receipts, warnings and review outcomes", async () => {
  const h = harness();
  const result = await h.orchestrator.saveQueueItemWithProvider({});
  assert.equal(result.parentKey, "ABCDEFGH");
  assert.deepEqual(result.warnings, ["Missing resource"]);
  const failed = harness({ provider: { saveWebPageWithSnapshot: async () => ({ ok: false, outcome: "needs_review", error: "Changed item" }) } });
  assert.equal((await failed.orchestrator.saveQueueItemWithProvider({})).outcome, "needs_review");
  assert.equal(failed.diagnostics.at(-1).lastError, "Changed item");
});

import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import SparkMD5 from "../vendor/md5.js";
import { createLocalClient } from "../zotero/local-client.js";
import { createLocalProvider } from "../zotero/provider-local.js";
import { createSaveJobRepo } from "../background/save-job-repo.js";

function harness({ loseResponse, captureFailure, rejectCreate } = {}) {
  const items = new Map();
  const requests = [];
  const uploads = new Map();
  const jobs = createSaveJobRepo({ indexedDBImpl: new IDBFactory() });
  const bytes = new TextEncoder().encode('<!doctype html><html><body>Saved café 🌍</body></html>').buffer;
  let serverID = "test-server", captureCount = 0, keyCount = 0, loss = loseResponse;
  const auth = { serverID, key: "fixture-key", remember: true };
  const destination = { serverID, libraryPath: "/users/0", collectionKey: "", label: "My Library" };
  const client = createLocalClient({ fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    const method = options.method;
    requests.push({ path, method });
    let data = {}, status = 200, phase;
    if (path === "/api/") data = "Root";
    else if (path.endsWith("/collections")) data = [];
    else if (method === "GET") {
      const item = items.get(path.split("/").at(-1));
      if (!item) status = 404;
      else data = { key: item.key, data: { ...item } };
    } else if (path.endsWith("/items")) {
      const item = JSON.parse(options.body)[0];
      if (rejectCreate) data = { failed: { 0: { code: 403 } } };
      else {
        assert.equal(item.version, 0);
        assert.equal(items.has(item.key), false, "must reconcile before attempting another create");
        items.set(item.key, { ...item, version: 1 });
        data = { successful: { 0: { key: item.key } } };
      }
      phase = item.itemType === "webpage" ? "parent" : "attachment";
    } else if (path.includes("/local/uploads/")) {
      phase = "bytes";
      uploads.get(path.split("/").at(-1)).bytes = options.body;
      status = 201;
    } else if (path.endsWith("/file")) {
      const item = items.get(path.split("/").at(-2));
      const form = new URLSearchParams(options.body);
      assert.equal(options.headers.get("If-None-Match"), "*");
      if (form.has("upload")) {
        phase = "register";
        const upload = uploads.get(form.get("upload"));
        assert.equal(SparkMD5.ArrayBuffer.hash(upload.bytes), upload.md5);
        item.md5 = upload.md5; status = 204;
      } else {
        phase = "authorize-upload";
        assert.equal(Number(form.get("filesize")), bytes.byteLength);
        const token = `upload${uploads.size}`;
        uploads.set(token, { md5: form.get("md5") });
        data = { url: `http://127.0.0.1:23119/api/local/uploads/${token}`, uploadKey: token, prefix: "", suffix: "" };
      }
    } else assert.fail(`unexpected ${method} ${path}`);
    if (loss && phase === loss) { loss = null; throw new Error("Lost response after effect"); }
    return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: {
      "Content-Type": "application/json", "Zotero-API-Version": "3", "Zotero-Server-ID": serverID
    } });
  } });
  function provider() { return createLocalProvider({ client, jobs, getSettings: async () => ({ auth, destination }),
    randomKey: () => ++keyCount === 1 ? "ABCDEFGH" : "JKLMNPQR",
    capture: async () => { captureCount++; if (captureFailure) throw new Error("Capture failed"); return { bytes, title: "Fixture", url: "https://example.com/final", warnings: [] }; }
  }); }
  const input = { queueItem: { id: "q1", url: "https://example.com/start", title: "Old" }, tabId: 12 };
  return { provider, input, items, requests, jobs, bytes, uploads, destination,
    changeServer: () => { serverID = "different"; }, captures: () => captureCount };
}

test("local provider captures before creating a webpage and imported HTML attachment, then releases payload", async () => {
  const h = harness();
  const result = await h.provider().saveWebPageWithSnapshot(h.input);
  assert.equal(result.ok, true, result.error);
  assert.equal(h.items.size, 2);
  assert.equal(h.items.get(result.parentKey).url, "https://example.com/final");
  assert.equal(h.items.get(result.attachmentKey).md5, SparkMD5.ArrayBuffer.hash(h.bytes));
  assert.equal((await h.jobs.get("q1")).phase, "completed");
  assert.equal(await h.jobs.payload("q1"), undefined);
});

for (const phase of ["parent", "attachment", "authorize-upload", "bytes", "register"]) {
  test(`restart after lost ${phase} response reuses keys and completes without duplicate items`, async () => {
    const h = harness({ loseResponse: phase });
    const first = await h.provider().saveWebPageWithSnapshot(h.input);
    assert.equal(first.ok, false);
    h.destination.collectionKey = "ZZZZZZZZ"; // Panel changes cannot redirect a retry.
    const result = await h.provider().saveWebPageWithSnapshot(h.input);
    assert.equal(result.ok, true, result.error);
    assert.equal(h.items.size, 2);
    assert.equal(h.captures(), 1);
    assert.deepEqual(h.items.get(result.parentKey).collections, []);
  });
}

test("capture failure makes no library writes; per-object batch failure is not success", async () => {
  const h = harness({ captureFailure: true });
  assert.equal((await h.provider().saveWebPageWithSnapshot(h.input)).ok, false);
  assert.equal(h.requests.some(r => r.method === "POST"), false);
  const rejected = harness({ rejectCreate: true });
  const result = await rejected.provider().saveWebPageWithSnapshot(rejected.input);
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected/);
});

test("a changed server or edited item requires review and never overwrites or creates a replacement", async () => {
  const h = harness({ loseResponse: "parent" });
  await h.provider().saveWebPageWithSnapshot(h.input);
  h.items.get("ABCDEFGH").title = "User changed this";
  assert.equal((await h.provider().saveWebPageWithSnapshot(h.input)).outcome, "needs_review");
  assert.equal(h.items.size, 1);
  h.changeServer();
  assert.equal((await h.provider().saveWebPageWithSnapshot(h.input)).outcome, "needs_review");
  assert.equal(h.items.size, 1);
});

test("lost payload after a parent write requires review; completed receipt prevents repeat writes", async () => {
  const h = harness({ loseResponse: "parent" });
  await h.provider().saveWebPageWithSnapshot(h.input);
  await h.jobs.cleanup(["q1"], Date.now() + 25 * 3600000);
  assert.equal((await h.provider().saveWebPageWithSnapshot(h.input)).outcome, "needs_review");
  const complete = harness();
  await complete.provider().saveWebPageWithSnapshot(complete.input);
  const count = complete.requests.length;
  assert.equal((await complete.provider().saveWebPageWithSnapshot(complete.input)).ok, true);
  assert.equal(complete.requests.slice(count).some(r => r.method === "POST"), false);
});

test("cancellation before capture makes no writes", async () => {
  const h = harness();
  const signal = AbortSignal.abort(new Error("Stopped"));
  assert.equal((await h.provider().saveWebPageWithSnapshot({ ...h.input, signal })).ok, false);
  assert.equal(h.items.size, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { captureSnapshot } from "../background/snapshot-capture.js";

function mockCapture({ html = "<html>café 🌍</html>", resultDocument = "doc", permission = true } = {}) {
  let released = false;
  const chromeImpl = {
    tabs: { get: async () => ({ url: "https://example.org/final", title: "Fixture" }) },
    permissions: { contains: async () => permission },
    scripting: { executeScript: async ({ files, args, func, target }) => {
      if (files) return [{ documentId: "doc" }];
      if (func.toString().includes("release")) { released = true; return []; }
      if (func.toString().includes("start")) return [];
      assert.deepEqual(target.documentIds, ["doc"]);
      return [{ documentId: resultDocument, result: { status: "complete", url: "https://example.org/final", title: "Fixture", warnings: [], length: html.length, chunk: html.slice(args[1], args[1] + 16000) } }];
    } }
  };
  return { chromeImpl, released: () => released };
}
test("capture reassembles UTF-16 chunks before UTF-8 encoding, including split surrogate pairs", async () => {
  const html = "a".repeat(15999) + "🌍café";
  const h = mockCapture({ html });
  const result = await captureSnapshot({ tabId: 1, captureId: "test", chromeImpl: h.chromeImpl });
  assert.equal(new TextDecoder().decode(result.bytes), html);
  assert.equal(h.released(), true);
});
test("capture rejects a changed document and missing permission after a redirect", async () => {
  const h = mockCapture({ resultDocument: "new-document" });
  await assert.rejects(captureSnapshot({ tabId: 1, captureId: "test", chromeImpl: h.chromeImpl }), /document changed/);
  assert.equal(h.released(), true);
  const denied = mockCapture({ permission: false });
  await assert.rejects(captureSnapshot({ tabId: 1, captureId: "test", chromeImpl: denied.chromeImpl }), error => error.permissionUrl === "https://example.org/final" && /grant access/.test(error.message));
});

test("missing capture bundles explain how to restore the checkout; permission failures keep their cause", async () => {
  for (const missing of ["vendor/single-file-hooks.js", "content/snapshot.bundle.js"]) {
    const h = mockCapture();
    const execute = h.chromeImpl.scripting.executeScript;
    h.chromeImpl.scripting.executeScript = async request => {
      if (request.files?.includes(missing)) throw new Error(`Could not load file: '${missing}'.`);
      return execute(request);
    };
    await assert.rejects(captureSnapshot({ tabId: 1, captureId: "test", chromeImpl: h.chromeImpl }), error =>
      error.message.includes(missing) && /Restore the complete repository checkout/.test(error.message));
  }
  const h = mockCapture();
  h.chromeImpl.scripting.executeScript = async () => { throw new Error("Cannot access contents of the page."); };
  await assert.rejects(captureSnapshot({ tabId: 1, captureId: "test", chromeImpl: h.chromeImpl }), /Cannot access contents/);
});

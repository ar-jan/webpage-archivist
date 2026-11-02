import test from "node:test";
import assert from "node:assert/strict";
import { createLocalClient, validateDestination } from "../zotero/local-client.js";

function response(body = "", status = 200, headers = {}) {
  return new Response(status === 204 ? null : body, { status, headers: {
    "Zotero-Server-ID": "test-server", "Zotero-API-Version": "3", "X-Zotero-Version": "10.0.6", ...headers
  } });
}

test("local client uses fixed loopback, API identity, no redirects and empty response handling", async () => {
  let seen;
  const client = createLocalClient({ fetchImpl: async (url, options) => { seen = { url, ...options }; return response("", 204); } });
  const result = await client.request("/api/users/0/items/ABCDEFGH/file", {
    method: "POST", auth: { key: "test-key", serverID: "test-server" }, form: { upload: "token" }, headers: { "If-None-Match": "*" }
  });
  assert.equal(result.status, 204);
  assert.equal(result.data, "");
  assert.equal(seen.url, "http://127.0.0.1:23119/api/users/0/items/ABCDEFGH/file");
  assert.equal(seen.redirect, "error");
  assert.equal(seen.headers.get("X-Zotero-Connector-API-Version"), "3");
  assert.equal(seen.headers.get("Zotero-API-Key"), "test-key");
  assert.equal(seen.headers.get("Zotero-Server-ID"), "test-server");
  assert.equal(seen.body, "upload=token");
});

test("local client rejects other hosts, ports, endpoints and query credentials without fetching", async () => {
  const client = createLocalClient({ fetchImpl: () => { assert.fail("must not fetch"); } });
  for (const path of ["https://example.org/api/", "http://127.0.0.1:9999/api/", "/connector/saveItems", "/api/?key=secret", "http://user@127.0.0.1:23119/api/"]) {
    await assert.rejects(client.request(path), /Unsupported/);
  }
  assert.throws(() => validateDestination({ libraryPath: "/users/123" }), /destination/);
});

test("local client validates server binding and handles 401 without requesting authorization", async () => {
  const client = createLocalClient({ fetchImpl: async () => response("Unauthorized", 401) });
  await assert.rejects(client.request("/api/", { serverID: "another-server" }), error => error.code === "SERVER_CHANGED");
  await assert.rejects(client.request("/api/"), error => error.status === 401 && /Always Allow/.test(error.message));
});

test("local client distinguishes a missing item from malformed JSON and interrupted requests", async () => {
  const missing = createLocalClient({ fetchImpl: async () => response("", 404) });
  assert.equal(await missing.request("/api/users/0/items/ABCDEFGH", { allow404: true }), null);
  const malformed = createLocalClient({ fetchImpl: async () => response("{", 200, { "Content-Type": "application/json" }) });
  await assert.rejects(malformed.health(), /invalid JSON/);
  const timed = createLocalClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) });
  await assert.rejects(timed.health(), /timed out/);
});

test("upload bytes never carry the local API key", async () => {
  const client = createLocalClient({ fetchImpl: async (_url, { headers }) => {
    assert.equal(headers.has("Zotero-API-Key"), false);
    return response("", 201);
  } });
  await client.request("/api/local/uploads/abcd", { method: "POST", auth: { serverID: "test-server", key: "test-key" }, bytes: new Uint8Array([1]) });
});

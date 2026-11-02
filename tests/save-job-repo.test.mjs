import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createSaveJobRepo } from "../background/save-job-repo.js";

test("job completion retains the receipt and removes bytes; cleanup removes orphan receipts", async () => {
  const repo = createSaveJobRepo({ indexedDBImpl: new IDBFactory() });
  const job = { id: "q1", createdAt: Date.now(), phase: "captured", parentKey: "ABCDEFGH" };
  await repo.capture(job, new Uint8Array([1, 2]).buffer);
  assert.equal((await repo.payload("q1")).byteLength, 2);
  await repo.complete(job);
  assert.equal(await repo.payload("q1"), undefined);
  assert.equal((await repo.get("q1")).phase, "completed");
  await repo.cleanup([]);
  assert.equal(await repo.get("q1"), undefined);
});

test("expired payloads are not reused, but their item keys survive for review", async () => {
  const repo = createSaveJobRepo({ indexedDBImpl: new IDBFactory() });
  const job = { id: "q1", createdAt: Date.now() - 25 * 3600000, parentKey: "ABCDEFGH" };
  await repo.capture(job, new Uint8Array([1]).buffer);
  assert.equal(await repo.payload("q1"), undefined);
  assert.equal((await repo.get("q1")).parentKey, "ABCDEFGH");
});

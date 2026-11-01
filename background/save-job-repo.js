const MAX_PAYLOAD_STORAGE = 128 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function createSaveJobRepo({ indexedDBImpl = globalThis.indexedDB, name = "archivist-local-saves" } = {}) {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("jobs", { keyPath: "id" });
        request.result.createObjectStore("payloads");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return database;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["jobs", "payloads"], mode);
      let result;
      tx.oncomplete = () => resolve(result?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Snapshot storage failed."));
      try { result = action(tx.objectStore("jobs"), tx.objectStore("payloads")); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  return {
    get: id => transaction("readonly", jobs => jobs.get(id)),
    async payload(id) {
      const job = await transaction("readonly", jobs => jobs.get(id));
      if (job && Date.now() - job.createdAt > RETENTION_MS) {
        await transaction("readwrite", (jobs, payloads) => {
          payloads.delete(id); jobs.put({ ...job, payloadBytes: 0 });
        });
        return undefined;
      }
      return transaction("readonly", (_jobs, payloads) => payloads.get(id));
    },
    put: job => transaction("readwrite", jobs => jobs.put(job)),
    async capture(job, bytes) {
      await transaction("readwrite", (jobs, payloads) => {
        const read = jobs.getAll();
        read.onsuccess = () => {
          let used = 0;
          for (const previous of read.result) {
            if (Date.now() - previous.createdAt > RETENTION_MS) {
              payloads.delete(previous.id); jobs.put({ ...previous, payloadBytes: 0 });
            } else used += previous.payloadBytes || 0;
          }
          if (used + bytes.byteLength > MAX_PAYLOAD_STORAGE) { txAbort(); return; }
          jobs.put({ ...job, payloadBytes: bytes.byteLength });
          payloads.put(bytes, job.id);
        };
        function txAbort() { jobs.transaction.abort(); }
      });
    },
    complete: job => transaction("readwrite", (jobs, payloads) => {
      payloads.delete(job.id);
      return jobs.put({ ...job, phase: "completed", payloadBytes: 0 });
    }),
    async cleanup(queueIds, now = Date.now()) {
      await transaction("readwrite", (jobs, payloads) => {
        const read = jobs.getAll();
        read.onsuccess = () => {
          for (const job of read.result) {
            if (!queueIds.includes(job.id)) { jobs.delete(job.id); payloads.delete(job.id); }
            else if (job.payloadBytes && now - job.createdAt > RETENTION_MS) {
              payloads.delete(job.id); jobs.put({ ...job, payloadBytes: 0 });
            }
          }
        };
      });
    }
  };
}

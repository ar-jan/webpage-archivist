import SparkMD5 from "../vendor/md5.js";
import { createLocalClient, LocalAPIError, LOCAL_ORIGIN, validateDestination } from "./local-client.js";
import { getLocalSettings } from "./local-settings.js";
import { createSaveJobRepo } from "../background/save-job-repo.js";
import { captureSnapshot } from "../background/snapshot-capture.js";

export function createLocalProvider({ client = createLocalClient(), jobs = createSaveJobRepo(),
  getSettings = getLocalSettings, capture = captureSnapshot, randomKey = createItemKey } = {}) {
  async function saveWebPageWithSnapshot({ queueItem, tabId, signal }) {
    let job = await jobs.get(queueItem.id);
    const check = () => signal?.throwIfAborted();
    try {
      check();
      const { auth, destination } = await getSettings();
      const health = await client.health();
      if (job && job.serverID !== health.serverID) throw conflict("This save belongs to a different Zotero database.");
      if (!auth?.key || !auth.remember || auth.serverID !== health.serverID) {
        throw new Error("Connect to Zotero and choose Always Allow before saving.");
      }
      if (job?.phase === "completed") return success(job);
      if (!job) {
        if (destination?.serverID !== health.serverID) throw new Error("Select a destination for this Zotero database.");
        const target = validateDestination(destination);
        // Verify destination exists before capturing or making any writes.
        await client.request(`/api${target.libraryPath}/collections${target.collectionKey ? `/${target.collectionKey}` : ""}`, { serverID: auth.serverID, signal });
        const snapshot = await capture({ tabId, captureId: crypto.randomUUID(), signal });
        check();
        job = { id: queueItem.id, serverID: health.serverID, ...target,
          parentKey: randomKey(), attachmentKey: randomKey(), url: snapshot.url,
          title: snapshot.title, warnings: snapshot.warnings, documentId: snapshot.documentId,
          createdAt: Date.now(), phase: "captured", md5: SparkMD5.ArrayBuffer.hash(snapshot.bytes),
          size: snapshot.bytes.byteLength, payloadBytes: snapshot.bytes.byteLength };
        await jobs.capture(job, snapshot.bytes);
      }
      const path = `/api${job.libraryPath}/items`;
      const parent = { key: job.parentKey, version: 0, itemType: "webpage", title: job.title,
        url: job.url, accessDate: new Date(job.createdAt).toISOString(),
        collections: job.collectionKey ? [job.collectionKey] : [] };
      const attachment = { key: job.attachmentKey, version: 0, itemType: "attachment",
        parentItem: job.parentKey, linkMode: "imported_url", title: "Snapshot", url: job.url,
        contentType: "text/html", charset: "UTF-8", filename: "snapshot.html" };
      const persist = async () => { check(); await jobs.put(job); };
      const getItem = key => client.request(`${path}/${key}`, { serverID: job.serverID, signal, allow404: true });
      async function ensureItem(item, field) {
        check();
        let existing = await getItem(item.key);
        if (!existing) {
          if (job[field]) throw conflict("A previously saved Zotero item was deleted. Check the library before retrying.");
          job.phase = `creating_${field}`; job.writeStarted = true; await persist();
          const response = await client.request(path, { method: "POST", auth, signal, json: [item] });
          const failure = response.data?.failed?.["0"];
          // A racing/lost create may now exist. Always inspect the keyed object.
          existing = await getItem(item.key);
          if (!existing) throw new LocalAPIError(failure ? `Zotero rejected the item (${failure.code || "invalid item"}).`
            : "Zotero did not return the created item.", { status: failure?.code });
        }
        assertMatchingItem(existing.data, item);
        job[field] = true; job.phase = `${field}_created`; await persist();
        return existing.data;
      }
      await ensureItem(parent, "parent");
      let attachmentData = await ensureItem(attachment, "attachment");
      const hash = attachmentData.data?.md5;
      if (hash && hash !== job.md5) throw conflict("The Zotero attachment has different contents. It was not overwritten.");
      if (hash !== job.md5) {
        const bytes = await jobs.payload(job.id);
        if (!bytes || SparkMD5.ArrayBuffer.hash(bytes) !== job.md5) throw conflict("The saved snapshot payload is missing or damaged. Check the partial Zotero item.");
        check();
        const headers = { "If-None-Match": "*" };
        job.phase = "uploading"; await persist();
        const upload = (await client.request(`${path}/${job.attachmentKey}/file`, {
          method: "POST", auth, signal, headers, form: {
            md5: job.md5, filename: "snapshot.html", filesize: String(job.size),
            mtime: String(job.createdAt), contentType: "text/html", charset: "UTF-8"
          }
        })).data;
        if (upload?.exists !== 1) {
          if (typeof upload?.uploadKey !== "string" || !/^[a-zA-Z0-9]+$/.test(upload.uploadKey)
            || upload.url !== `${LOCAL_ORIGIN}/api/local/uploads/${upload.uploadKey}`
            || upload.prefix !== "" || upload.suffix !== "") throw new Error("Unsupported Zotero upload response.");
          check();
          const uploaded = await client.request(upload.url, { method: "POST", bytes, signal, serverID: job.serverID });
          if (uploaded.status !== 201) throw new Error("Zotero did not accept the snapshot bytes.");
          check(); job.phase = "registering"; await persist();
          const registered = await client.request(`${path}/${job.attachmentKey}/file`, {
            method: "POST", auth, signal, headers, form: { upload: upload.uploadKey }
          });
          if (registered.status !== 204) throw new Error("Zotero did not confirm the snapshot import.");
        }
        attachmentData = (await getItem(job.attachmentKey))?.data;
        assertMatchingItem(attachmentData, attachment);
        if (attachmentData?.data?.md5 !== job.md5) throw new Error("Zotero did not confirm the saved snapshot checksum.");
      }
      check();
      await jobs.complete(job);
      return success(job);
    } catch (error) {
      return { ok: false, permissionUrl: error.permissionUrl, authorizationRequired: error.status === 401, outcome: error.code === "CONFLICT" || error.code === "SERVER_CHANGED" ? "needs_review" : "failed",
        error: `${error.message || "Save interrupted."}${job?.writeStarted && !["CONFLICT", "SERVER_CHANGED"].includes(error.code) ? " Retry resumes the same Zotero item." : ""}` };
    }
  }
  return { mode: "local_zotero", saveWebPageWithSnapshot, jobs };
}

function assertMatchingItem(response, expected) {
  const actual = response?.data;
  const fields = expected.itemType === "webpage" ? ["itemType", "url", "title"]
    : ["itemType", "parentItem", "linkMode", "url", "contentType"];
  if (response?.key !== expected.key || !actual || actual.deleted
    || fields.some(field => actual[field] !== expected[field])
    || (expected.collections?.length && !expected.collections.every(key => actual.collections?.includes(key)))) {
    throw conflict("The existing Zotero item differs from this save. It was not modified.");
  }
}
function conflict(message) { return new LocalAPIError(message, { code: "CONFLICT" }); }
function success(job) { return { ok: true, parentKey: job.parentKey, attachmentKey: job.attachmentKey, warnings: job.warnings }; }
function createItemKey() {
  const alphabet = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte % alphabet.length]).join("");
}

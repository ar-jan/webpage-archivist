import { isHttpUrl, toOriginPattern } from "../shared/protocol.js";
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export async function captureSnapshot({ tabId, captureId, signal, chromeImpl = globalThis.chrome,
  timeoutMs = 120000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const tab = await chromeImpl.tabs.get(tabId);
  if (!isHttpUrl(tab.url)) throw new Error("Only HTTP(S) HTML pages can be captured.");
  if (!await chromeImpl.permissions.contains({ origins: [toOriginPattern(tab.url)] })) {
    const error = new Error(`Access to ${new URL(tab.url).origin} is needed after a redirect. Use Retry / Reconcile, then Start to grant access.`);
    error.permissionUrl = tab.url;
    throw error;
  }
  signal?.throwIfAborted();
  const inject = async (file, world = "ISOLATED") => {
    try {
      return await chromeImpl.scripting.executeScript({ target: { tabId, frameIds: [0] }, world, files: [file] });
    } catch (error) {
      if (/Could not load file/i.test(error.message)) {
        throw new Error(`Snapshot runtime file is missing (${file}). Restore the complete repository checkout, load its root folder, then reload Archivist.`);
      }
      throw error;
    }
  };
  await inject("vendor/single-file-hooks.js", "MAIN");
  const injected = await inject("content/snapshot.bundle.js");
  const documentId = injected[0]?.documentId;
  if (!documentId) throw new Error("Cannot identify the capture document.");
  const target = { tabId, documentIds: [documentId] };
  await chromeImpl.scripting.executeScript({ target, func: id => globalThis.archivistCapture.start(id), args: [captureId] });
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let expectedLength;
  const chunks = [];
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const results = await chromeImpl.scripting.executeScript({ target,
        func: (id, position) => globalThis.archivistCapture.read(id, position), args: [captureId, offset] });
      const result = results[0]?.result;
      if (!result || results[0].documentId !== documentId || result.url !== tab.url) throw new Error("Capture document changed.");
      if (result.status === "failed") throw new Error(result.error || "Snapshot capture failed.");
      if (result.status !== "complete") { await wait(1000); continue; }
      if (!Number.isSafeInteger(result.length) || result.length <= 0 || result.length > MAX_SNAPSHOT_BYTES
        || typeof result.chunk !== "string" || result.chunk.length > 16000) throw new Error("Invalid snapshot transfer.");
      expectedLength ??= result.length;
      if (result.length !== expectedLength || (!result.chunk.length && offset < expectedLength)) throw new Error("Incomplete snapshot transfer.");
      chunks.push(result.chunk); offset += result.chunk.length;
      if (offset > expectedLength) throw new Error("Snapshot length mismatch.");
      if (offset === expectedLength) {
        const bytes = new TextEncoder().encode(chunks.join(""));
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds the 20 MiB limit.");
        return { bytes: bytes.buffer, url: result.url, title: result.title || tab.title || result.url,
          warnings: result.warnings || [], documentId };
      }
    }
    throw new Error("Snapshot capture timed out (120 seconds).");
  } finally {
    try { await chromeImpl.scripting.executeScript({ target, func: id => globalThis.archivistCapture.release(id), args: [captureId] }); } catch { /* Navigated or closed. */ }
  }
}

import { getPageData } from "single-file-core/single-file.js";

// This object exists only in Archivist's isolated world. Pages cannot read it or
// request local API operations. The worker pulls bounded chunks from this document.
if (!globalThis.archivistCapture) {
  let current;
  globalThis.archivistCapture = {
    start(id) {
      if (current?.id === id) return;
      const capture = current = { id, status: "capturing", url: location.href, title: document.title, warnings: [] };
      void run(capture);
    },
    read(id, offset) {
      if (!current || current.id !== id) throw new Error("Capture document changed.");
      if (location.href !== current.url) throw new Error("Page navigated during capture.");
      const { status, url, title, warnings, error, content } = current;
      return { status, url, title, warnings, error, length: content?.length,
        chunk: status === "complete" ? content.slice(offset, offset + 16000) : undefined };
    },
    release(id) { if (current?.id === id) { current.cancelled = true; current = null; } }
  };

  async function run(capture) {
    try {
      if (!["text/html", "application/xhtml+xml"].includes(document.contentType)) {
        throw new Error("Only HTML pages can be archived with a snapshot.");
      }
      if (document.querySelector("iframe,frame")) capture.warnings.push("Embedded frames are omitted.");
      let resourceFailures = 0;
      let resourceBytes = 0;
      const data = await getPageData({
        removeScripts: true, removeFrames: true, removeHiddenElements: false,
        removeUnusedStyles: false, removeUnusedFonts: false, compressHTML: false,
        loadDeferredContent: true, loadDeferredContentMaxIdleTime: 1000,
        loadDeferredContentMaxIdleTimeDelay: 2000,
        loadDeferredContentKeepZoomLevel: true,
        blockVideos: true, blockAudios: true, blockAlternativeImages: true,
        maxResourceSizeEnabled: true, maxResourceSize: 5,
        networkTimeout: 15000, insertMetaCSP: true, saveFavicon: true,
        filenameTemplate: "snapshot.html"
      }, {
        fetch: async (url, options = {}) => {
          try {
            if (capture.cancelled) throw new Error("Capture cancelled.");
            const parsed = new URL(url, location.href);
            if (!["http:", "https:", "data:", "blob:"].includes(parsed.protocol)) throw new Error("Unsupported resource URL.");
            const response = await fetch(parsed.href, {
              ...options, signal: AbortSignal.timeout(15000),
              credentials: parsed.origin === location.origin ? "include" : "omit"
            });
            if (!response.ok) throw new Error("Resource unavailable.");
            const reader = response.body?.getReader();
            const chunks = [];
            let size = 0;
            if (reader) {
              try {
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  size += value.length; resourceBytes += value.length;
                  if (size > 5 * 1024 * 1024 || resourceBytes > 40 * 1024 * 1024) throw new Error("Resource limit reached.");
                  chunks.push(value);
                }
              } finally { await reader.cancel(); }
            }
            const buffer = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
            return { status: response.status, headers: response.headers, arrayBuffer: async () => buffer.buffer };
          } catch (error) { resourceFailures++; throw error; }
        }
      });
      if (capture.cancelled) return;
      if (location.href !== capture.url) throw new Error("Page navigated during capture.");
      if (typeof data.content !== "string" || !data.content.trim()) throw new Error("Snapshot was empty.");
      if (new TextEncoder().encode(data.content).byteLength > 20 * 1024 * 1024) throw new Error("Snapshot exceeds the 20 MiB limit.");
      if (resourceFailures) capture.warnings.push(`${resourceFailures} resource request(s) failed; some assets may be missing.`);
      capture.content = data.content;
      capture.status = "complete";
    } catch (error) {
      capture.error = error.message || "Snapshot capture failed.";
      capture.status = "failed";
    }
  }
}

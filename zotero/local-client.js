export const LOCAL_ORIGIN = "http://127.0.0.1:23119";
export const LOCAL_PERMISSION = "http://127.0.0.1/*";
export const ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
const LIBRARY_PATTERN = /^\/(users\/0|groups\/[1-9][0-9]*)$/;

export class LocalAPIError extends Error {
  constructor(message, { status = 0, code = "API_ERROR" } = {}) {
    super(message);
    this.name = "LocalAPIError";
    this.status = status;
    this.code = code;
  }
}

export function validateDestination(value) {
  if (!value || !LIBRARY_PATTERN.test(value.libraryPath)
    || (value.collectionKey && !ITEM_KEY_PATTERN.test(value.collectionKey))) {
    throw new LocalAPIError("Select a valid Zotero destination.");
  }
  return { libraryPath: value.libraryPath, collectionKey: value.collectionKey || "" };
}

export function createLocalClient({ fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  async function request(path, { method = "GET", auth = null, serverID = auth?.serverID,
    json, form, bytes, headers = {}, signal, deadlineMs = timeoutMs, allow404 = false } = {}) {
    const url = new URL(path, LOCAL_ORIGIN);
    const allowed = /^\/api\/(?:local\/authorize|local\/uploads\/[a-zA-Z0-9]+|users\/0\/groups|(?:users\/0|groups\/[1-9][0-9]*)\/(?:collections(?:\/[A-Z0-9]{8})?|items(?:\/[A-Z0-9]{8}(?:\/file)?)?))?$/;
    if (url.origin !== LOCAL_ORIGIN || !allowed.test(url.pathname) || url.search || url.hash
      || url.username || url.password || !["GET", "POST"].includes(method)) {
      throw new LocalAPIError("Unsupported local Zotero request.");
    }
    const requestHeaders = new Headers({
      "X-Zotero-Connector-API-Version": "3", "Zotero-API-Version": "3", ...headers
    });
    if (serverID) requestHeaders.set("Zotero-Server-ID", serverID);
    if (method !== "GET" && auth?.key && !url.pathname.startsWith("/api/local/uploads/")) {
      requestHeaders.set("Zotero-API-Key", auth.key);
    }
    let body;
    if (json !== undefined) {
      body = JSON.stringify(json);
      requestHeaders.set("Content-Type", "application/json");
    } else if (form) {
      body = new URLSearchParams(form).toString();
      requestHeaders.set("Content-Type", "application/x-www-form-urlencoded");
    } else if (bytes) {
      body = bytes;
      requestHeaders.set("Content-Type", "application/octet-stream");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await fetchImpl(url.href, {
        method, headers: requestHeaders, body, signal: controller.signal,
        redirect: "error", credentials: "omit", cache: "no-store"
      });
      const actualServer = response.headers.get("Zotero-Server-ID");
      const apiVersion = response.headers.get("Zotero-API-Version");
      if (!actualServer || apiVersion !== "3" || (serverID && serverID !== actualServer)) {
        throw new LocalAPIError("Zotero API identity changed or is unsupported. Connect to Zotero again.", { code: "SERVER_CHANGED" });
      }
      const text = await response.text();
      if (response.status === 404 && allow404) return null;
      if (!response.ok) {
        const message = response.status === 401 ? "Zotero authorization expired. Connect again and choose Always Allow."
          : response.status === 403 ? "Zotero denied access. Check local API access and library/file permissions."
          : `Zotero request failed (HTTP ${response.status}).`;
        throw new LocalAPIError(message, { status: response.status });
      }
      let data = text;
      if (text && response.headers.get("Content-Type")?.includes("application/json")) {
        try { data = JSON.parse(text); } catch { throw new LocalAPIError("Zotero returned invalid JSON."); }
      }
      return { status: response.status, data, serverID: actualServer,
        version: response.headers.get("X-Zotero-Version"), apiVersion };
    } catch (error) {
      if (error instanceof LocalAPIError) throw error;
      throw new LocalAPIError(controller.signal.aborted ? "Zotero request was interrupted or timed out. Retry to reconcile the save."
        : "Cannot reach Zotero. Open Zotero and enable its local API.", { code: "NETWORK" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return {
    request,
    health: () => request("/api/"),
    authorize: (serverID) => request("/api/local/authorize", {
      method: "POST", serverID, json: { appName: "Webpage Archivist" }, deadlineMs: 120000
    }),
    async destinations(serverID) {
      const groups = (await request("/api/users/0/groups", { serverID })).data;
      if (!Array.isArray(groups)) throw new LocalAPIError("Invalid Zotero library response.");
      const libraries = [{ libraryPath: "/users/0", label: "My Library" }];
      for (const group of groups) {
        const id = group.id ?? group.data?.id;
        if (Number.isSafeInteger(id) && id > 0) libraries.push({ libraryPath: `/groups/${id}`, label: group.data?.name || `Group ${id}` });
      }
      const result = [];
      for (const library of libraries) {
        result.push({ ...library, collectionKey: "" });
        const collections = (await request(`/api${library.libraryPath}/collections`, { serverID })).data;
        if (!Array.isArray(collections)) throw new LocalAPIError("Invalid Zotero collection response.");
        const names = new Map(collections.map(c => [c.key, c.data]));
        for (const collection of collections) {
          if (!ITEM_KEY_PATTERN.test(collection.key)) continue;
          const parts = [collection.data.name];
          const seen = new Set([collection.key]);
          let parent = collection.data.parentCollection;
          while (parent && names.has(parent) && !seen.has(parent)) {
            seen.add(parent); parts.unshift(names.get(parent).name); parent = names.get(parent).parentCollection;
          }
          result.push({ libraryPath: library.libraryPath, collectionKey: collection.key, label: `${library.label} / ${parts.join(" / ")}` });
        }
      }
      return result;
    }
  };
}

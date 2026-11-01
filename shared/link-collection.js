import {
  DEFAULT_SELECTOR_RULES,
  ERROR_CODES,
  STORAGE_KEYS,
  createError,
  createSuccess,
  isHttpUrl,
  sanitizeSelectorRules,
  toOriginPattern
} from "./protocol.js";
import { normalizeCollectedLinks, normalizeCollectorSettings } from "./state.js";

// Local collection must not depend on the worker or on Zotero's availability.
// Each browser operation is bounded; scrolling gets its configured time budget.
export async function collectLinksFromTab(tab, {
  chromeImpl = globalThis.chrome,
  operationTimeoutMs = 5000,
  collectionTimeoutMs
} = {}) {
  if (!Number.isInteger(tab?.id)) {
    return createError(ERROR_CODES.NO_ACTIVE_TAB, "No active tab found.");
  }
  if (!isHttpUrl(tab.url)) {
    return createError(ERROR_CODES.UNSUPPORTED_URL, "Collect Links only works on http(s) pages.");
  }

  const runId = crypto.randomUUID();
  let target;
  const step = (promise, label, timeoutMs = operationTimeoutMs) =>
    withTimeout(promise, timeoutMs, `${label} timed out. Try Collect Links again.`);

  try {
    const granted = await step(chromeImpl.permissions.contains({
      origins: [toOriginPattern(tab.url)]
    }), "Checking site access");
    if (!granted) {
      return createError(ERROR_CODES.MISSING_HOST_PERMISSION, "Host permission required.");
    }

    const stored = await step(chromeImpl.storage.local.get([
      STORAGE_KEYS.SELECTOR_RULES, STORAGE_KEYS.COLLECTOR_SETTINGS
    ]), "Reading collection settings");
    const rules = sanitizeSelectorRules(stored[STORAGE_KEYS.SELECTOR_RULES] ?? DEFAULT_SELECTOR_RULES);
    const settings = normalizeCollectorSettings(stored[STORAGE_KEYS.COLLECTOR_SETTINGS]);
    const injected = await step(chromeImpl.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["content/collector.js"]
    }), "Loading the page collector");
    const documentId = injected.find(result => result.frameId === 0)?.documentId;
    if (!documentId) throw new Error("Unable to identify the page document. Reload the page and try again.");
    target = { tabId: tab.id, documentIds: [documentId] };

    const results = await step(chromeImpl.scripting.executeScript({
      target,
      func: async (id, expectedUrl, payload) => {
        if (location.href !== expectedUrl) throw new Error("The page changed. Try Collect Links again.");
        const links = await globalThis.__archivistLinkCollector.run(id, payload);
        return { links, url: location.href };
      },
      args: [runId, tab.url, { ...settings, maxLinks: settings.maxLinksPerRun, rules }]
    }), "Reading page links", collectionTimeoutMs ?? (
      operationTimeoutMs + (settings.autoScrollEnabled
        ? settings.autoScrollMaxRounds * settings.autoScrollSettleDelayMs : 0)
    ));
    const result = results.find(entry => entry.documentId === documentId)?.result;
    if (!Array.isArray(result?.links)) throw new Error("The page collector did not return links. Reload the page and try again.");
    const currentTab = await step(chromeImpl.tabs.get(tab.id), "Checking the collected page");
    if (result.url !== tab.url || currentTab.url !== tab.url) {
      throw new Error("The page changed during collection. Try Collect Links again.");
    }
    const links = normalizeCollectedLinks(result.links);
    await step(chromeImpl.storage.local.set({ [STORAGE_KEYS.COLLECTED_LINKS]: links }), "Saving collected links");
    return createSuccess({ links, collectedCount: links.length });
  } catch (error) {
    // Cancellation is best effort, scoped to this run and document. A late
    // collector response must never continue to the persistence step.
    if (target) {
      try {
        void chromeImpl.scripting.executeScript({
          target,
          func: id => globalThis.__archivistLinkCollector?.cancel(id),
          args: [runId]
        }).catch(() => {});
      } catch (_error) {
      }
    }
    return createError(ERROR_CODES.COLLECTOR_ERROR, error?.message || "Collect Links failed.");
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

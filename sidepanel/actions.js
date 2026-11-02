import {
  ERROR_CODES,
  MESSAGE_TYPES,
  createError,
  createSuccess,
  sanitizeSelectorRules,
  toOriginPattern
} from "../shared/protocol.js";
import { collectLinksFromTab } from "../shared/link-collection.js";
import { withTimeout } from "../shared/async.js";
import { readPanelState, saveCollectedLinks, saveQueueSettings, saveSelectorRules, saveProviderDiagnostics } from "../shared/storage-repo.js";
import { readLocalDiagnostics } from "../zotero/diagnostics.js";

export async function getPanelStateAction() {
  return createSuccess(await withTimeout(readPanelState(), 5000, "Reading local settings timed out. Reopen the panel to retry."));
}

export async function refreshDiagnosticsAction() {
  const diagnostics = await readLocalDiagnostics();
  await saveProviderDiagnostics(diagnostics);
  return diagnostics;
}

export async function collectLinksAction(tab) {
  return collectLinksFromTab(tab);
}

export async function setCollectedLinksAction(links) {
  const saved = await withTimeout(saveCollectedLinks(links), 5000, "Saving link selection timed out. Check the saved selection before retrying.");
  return createSuccess({ links: saved });
}

export async function authorQueueFromSelectionAction(links) {
  return sendRuntimeMessage(MESSAGE_TYPES.AUTHOR_QUEUE_FROM_SELECTION, {
    links
  });
}

export async function setQueueSettingsAction(queueSettings) {
  const saved = await withTimeout(saveQueueSettings(queueSettings), 5000, "Saving queue settings timed out. Check the settings before retrying.");
  return createSuccess({ queueSettings: saved });
}

export async function clearQueueAction() {
  return sendRuntimeMessage(MESSAGE_TYPES.CLEAR_QUEUE);
}

export async function clearArchivedQueueAction() {
  return sendRuntimeMessage(MESSAGE_TYPES.CLEAR_ARCHIVED_QUEUE);
}

export async function queueLifecycleAction(messageType, payload = undefined) {
  return sendRuntimeMessage(messageType, payload);
}

export async function setSelectorRulesAction(rules) {
  const selectorRules = sanitizeSelectorRules(rules);
  if (!Array.isArray(rules) || selectorRules.length === 0 || selectorRules.length !== rules.length) {
    return createError(ERROR_CODES.INVALID_SELECTOR_RULES, "One or more selector rules are invalid.");
  }

  // The panel is a trusted extension context. Persist this local setting directly
  // rather than waiting for a service-worker message channel to acknowledge it.
  await saveSelectorRules(selectorRules);
  return createSuccess({ selectorRules });
}

export async function getActiveTabAction() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  return tabs[0] ?? null;
}

export async function getCurrentWindowIdAction() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    return Number.isInteger(currentWindow?.id) ? currentWindow.id : null;
  } catch (_error) {
    return null;
  }
}

export async function ensureHostPermissionAction(tabUrl) {
  const originPattern = toOriginPattern(tabUrl);
  if (!originPattern) {
    return { granted: false };
  }

  const permissionResult = await ensureHostPermissionsForUrlsAction([tabUrl]);
  return {
    granted: permissionResult.granted,
    alreadyGranted: permissionResult.alreadyGranted,
    originPattern
  };
}

export async function ensureHostPermissionsForUrlsAction(urls) {
  const requestedOrigins = collectOriginPatterns(urls);
  if (requestedOrigins.length === 0) {
    return {
      granted: true,
      alreadyGranted: true,
      requestedOrigins: []
    };
  }

  const missingOrigins = [];
  for (const originPattern of requestedOrigins) {
    const hasPermission = await chrome.permissions.contains({
      origins: [originPattern]
    });
    if (!hasPermission) {
      missingOrigins.push(originPattern);
    }
  }

  if (missingOrigins.length === 0) {
    return {
      granted: true,
      alreadyGranted: true,
      requestedOrigins: []
    };
  }

  const granted = await chrome.permissions.request({
    origins: missingOrigins
  });
  return {
    granted,
    alreadyGranted: false,
    requestedOrigins: missingOrigins
  };
}

export async function sendRuntimeMessage(type, payload = undefined, { timeoutMs = 45000 } = {}) {
  const message = payload === undefined ? { type } : { type, payload };
  try {
    return await withTimeout(chrome.runtime.sendMessage(message), timeoutMs,
      "The background worker did not reply. The command may still complete; check queue status before retrying. If it remains unavailable, reload Archivist and check its extension errors.");
  } catch (error) {
    return createError(ERROR_CODES.INTERNAL_ERROR, error.message || "The background worker is unavailable. Reload Archivist and check its extension errors.");
  }
}

function collectOriginPatterns(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const dedupedPatterns = [];
  const seen = new Set();
  for (const url of urls) {
    const originPattern = toOriginPattern(url);
    if (!originPattern || seen.has(originPattern)) {
      continue;
    }

    seen.add(originPattern);
    dedupedPatterns.push(originPattern);
  }

  return dedupedPatterns;
}

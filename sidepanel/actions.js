import {
  ERROR_CODES,
  MESSAGE_TYPES,
  STORAGE_KEYS,
  createError,
  createSuccess,
  sanitizeSelectorRules,
  toOriginPattern
} from "../shared/protocol.js";

export async function getPanelStateAction() {
  return sendRuntimeMessage(MESSAGE_TYPES.GET_PANEL_STATE);
}

export async function collectLinksAction() {
  return sendRuntimeMessage(MESSAGE_TYPES.COLLECT_LINKS);
}

export async function setCollectedLinksAction(links) {
  return sendRuntimeMessage(MESSAGE_TYPES.SET_COLLECTED_LINKS, {
    links
  });
}

export async function authorQueueFromSelectionAction(links) {
  return sendRuntimeMessage(MESSAGE_TYPES.AUTHOR_QUEUE_FROM_SELECTION, {
    links
  });
}

export async function setQueueSettingsAction(queueSettings) {
  return sendRuntimeMessage(MESSAGE_TYPES.SET_QUEUE_SETTINGS, {
    queueSettings
  });
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
  await chrome.storage.local.set({ [STORAGE_KEYS.SELECTOR_RULES]: selectorRules });
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

async function sendRuntimeMessage(type, payload = undefined) {
  const message = payload === undefined ? { type } : { type, payload };
  return chrome.runtime.sendMessage(message);
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

import {
  ERROR_CODES,
  MESSAGE_TYPES,
  createError,
  createSuccess
} from "../shared/protocol.js";
import {
  createQueueItemId,
  normalizeCollectedLinks
} from "../shared/state.js";
import { routeMessage, isPanelSender } from "./message-router.js";
import { createProviderOrchestrator } from "./provider-orchestrator.js";
import { createQueueEngine, QUEUE_ENGINE_ALARM_NAME } from "./queue-engine.js";
import { createQueueLifecycleHandlers } from "./queue-lifecycle.js";
import {
  ensureCollectorSettings,
  ensureProviderDiagnostics,
  ensureQueueItems,
  ensureQueueSettings,
  ensureQueueRuntime,
  ensureSelectorRules,
  getQueueItems,
  getQueueSettings,
  getQueueRuntime,
  saveProviderDiagnostics,
  saveQueueItems,
  saveQueueRuntime
} from "../shared/storage-repo.js";

const providerOrchestrator = createProviderOrchestrator({
  saveProviderDiagnostics
});

const queueEngine = createQueueEngine({
  getQueueRuntime,
  saveQueueRuntime,
  getQueueItems,
  saveQueueItems,
  getQueueSettings,
  saveQueueItemWithProvider: providerOrchestrator.saveQueueItemWithProvider
});

const queueLifecycleHandlers = createQueueLifecycleHandlers({
  getQueueRuntime,
  saveQueueRuntime,
  getQueueItems,
  saveQueueItems,
  queueEngine
});

const messageHandlers = {
  [MESSAGE_TYPES.AUTHOR_QUEUE_FROM_SELECTION]: async (message) =>
    authorQueueFromSelection(message.payload?.links),
  [MESSAGE_TYPES.CLEAR_QUEUE]: async () => queueLifecycleHandlers.clearQueue(),
  [MESSAGE_TYPES.CLEAR_ARCHIVED_QUEUE]: async () => queueLifecycleHandlers.clearArchivedQueue(),
  [MESSAGE_TYPES.REMOVE_QUEUE_ITEM]: async (message) =>
    queueLifecycleHandlers.removeQueueItem(message.payload?.queueItem),
  [MESSAGE_TYPES.START_QUEUE]: async (message) =>
    queueLifecycleHandlers.startQueue(message.payload?.queueRuntimeContext),
  [MESSAGE_TYPES.PAUSE_QUEUE]: async () => queueLifecycleHandlers.pauseQueue(),
  [MESSAGE_TYPES.RESUME_QUEUE]: async (message) =>
    queueLifecycleHandlers.resumeQueue(message.payload?.queueRuntimeContext),
  [MESSAGE_TYPES.STOP_QUEUE]: async () => queueLifecycleHandlers.stopQueue(),
  [MESSAGE_TYPES.RETRY_FAILED_QUEUE]: async () => queueLifecycleHandlers.retryFailedQueue(),
  [MESSAGE_TYPES.REVERSE_QUEUE]: async () => queueLifecycleHandlers.reverseQueue()
};

// Serialize queue mutations and cleanup; a new Start must not race a Clear.
let commandRun = Promise.resolve();
function enqueueCommand(message) {
  const result = commandRun.then(async () => {
    await initializeExtensionState();
    return handleMessage(message);
  });
  commandRun = result.catch(() => {});
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtensionState().catch(reportStartupError);
});

chrome.runtime.onStartup.addListener(() => {
  void initializeExtensionState().catch(reportStartupError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isPanelSender(sender, chrome.runtime)) {
    sendResponse(createError(ERROR_CODES.BAD_REQUEST, "Only the Archivist panel can issue commands."));
    return false;
  }
  enqueueCommand(message)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("[webpage-archivist] Unhandled runtime error", error);
      sendResponse(createError(ERROR_CODES.INTERNAL_ERROR, "Unexpected runtime error."));
    });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== QUEUE_ENGINE_ALARM_NAME) {
    return;
  }

  void initializeExtensionState().then(() => queueEngine.handleQueueAlarm()).catch(reportStartupError);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void initializeExtensionState().then(() => queueEngine.handleQueueTabUpdated(tabId, changeInfo)).catch(reportStartupError);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void initializeExtensionState().then(() => queueEngine.handleQueueTabRemoved(tabId)).catch(reportStartupError);
});

let initialization;
function initializeExtensionState() {
  initialization ??= initializeLocalState().catch(error => {
    initialization = null;
    throw error;
  });
  return initialization;
}

function reportStartupError(error) {
  console.error("[webpage-archivist] Background initialization failed.", error);
}

async function initializeLocalState() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await Promise.all([
    ensureCollectorSettings(),
    ensureQueueSettings(),
    ensureSelectorRules(),
    ensureQueueItems(),
    ensureQueueRuntime(),
    ensureProviderDiagnostics()
  ]);
  await providerOrchestrator.jobs.cleanup((await getQueueItems()).map(item => item.id));
  await configureSidePanelBehavior();
}

async function handleMessage(message) {
  if ([MESSAGE_TYPES.START_QUEUE, MESSAGE_TYPES.RESUME_QUEUE].includes(message?.type)) {
    const diagnostics = await providerOrchestrator.refreshProviderDiagnostics();
    if (!diagnostics.permissionGranted || !diagnostics.reachable || !diagnostics.authorized) {
      return createError(ERROR_CODES.PROVIDER_UNAVAILABLE, diagnostics.lastError);
    }
    // Existing jobs validate their pinned destination. A changed panel selection
    // must not prevent reconciliation; new jobs preflight the current selection.
  }
  const result = await routeMessage(message, messageHandlers);
  if ([MESSAGE_TYPES.CLEAR_QUEUE, MESSAGE_TYPES.CLEAR_ARCHIVED_QUEUE, MESSAGE_TYPES.REMOVE_QUEUE_ITEM].includes(message?.type) && result.ok) {
    // Wait for cancelled work before deleting its local receipts/payloads.
    await queueEngine.waitForIdle();
    await providerOrchestrator.jobs.cleanup((await getQueueItems()).map(item => item.id));
  }
  return result;
}

async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: true
    });
  } catch (error) {
    console.error("[webpage-archivist] Failed to configure side panel behavior.", error);
  }
}

async function authorQueueFromSelection(rawLinks) {
  const selectedLinks = normalizeCollectedLinks(rawLinks).filter((link) => link.selected !== false);
  if (selectedLinks.length === 0) {
    return createError(ERROR_CODES.BAD_REQUEST, "Select at least one link to add to queue.");
  }

  const queueItems = await getQueueItems();
  const seenQueueUrls = new Set(queueItems.map((item) => item.url.toLowerCase()));
  const nextQueueItems = [...queueItems];

  let addedCount = 0;
  let skippedCount = 0;
  const now = Date.now();
  for (const link of selectedLinks) {
    const dedupeKey = link.url.toLowerCase();
    if (seenQueueUrls.has(dedupeKey)) {
      skippedCount += 1;
      continue;
    }

    seenQueueUrls.add(dedupeKey);
    addedCount += 1;
    nextQueueItems.push({
      id: createQueueItemId(now, nextQueueItems.length + 1),
      url: link.url,
      title: link.title,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  await saveQueueItems(nextQueueItems);

  return createSuccess({
    queueItems: nextQueueItems,
    selectedCount: selectedLinks.length,
    addedCount,
    skippedCount
  });
}

void initializeExtensionState().then(() => queueEngine.recoverQueueEngineState()).catch(reportStartupError);

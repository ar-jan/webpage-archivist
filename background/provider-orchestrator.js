import { createLocalProvider } from "../zotero/provider-local.js";
import { createDefaultProviderDiagnostics } from "../zotero/provider-interface.js";
import { createLocalClient, LOCAL_PERMISSION, validateDestination } from "../zotero/local-client.js";
import { getLocalSettings, forgetLocalAuthorization } from "../zotero/local-settings.js";

export function createProviderOrchestrator({ saveProviderDiagnostics,
  provider = createLocalProvider(), client = createLocalClient(), getSettings = getLocalSettings,
  forgetAuthorization = forgetLocalAuthorization,
  hasPermission = () => chrome.permissions.contains({ origins: [LOCAL_PERMISSION] }) }) {
  async function refreshProviderDiagnostics() {
    const diagnostics = createDefaultProviderDiagnostics();
    try {
      diagnostics.permissionGranted = await hasPermission();
      if (!diagnostics.permissionGranted) throw new Error("Connect to Zotero to grant local access.");
      const health = await client.health();
      diagnostics.reachable = true; diagnostics.clientVersion = health.version;
      const { auth, destination } = await getSettings();
      diagnostics.authorized = Boolean(auth?.key && auth.remember && auth.serverID === health.serverID);
      if (!diagnostics.authorized) throw new Error("Connect to Zotero and choose Always Allow.");
      if (destination?.serverID !== health.serverID) throw new Error("Choose a destination for this Zotero database.");
      const target = validateDestination(destination);
      await client.request(`/api${target.libraryPath}/collections${target.collectionKey ? `/${target.collectionKey}` : ""}`, { serverID: health.serverID });
      diagnostics.targetLabel = destination.label;
      diagnostics.destinationReady = true;
    } catch (error) { diagnostics.lastError = error.message || "Zotero is unavailable."; }
    await saveProviderDiagnostics(diagnostics);
    return diagnostics;
  }
  async function resolveSaveProvider() {
    const diagnostics = await refreshProviderDiagnostics();
    return { diagnostics, provider: diagnostics.destinationReady ? provider : null, unavailableReason: diagnostics.lastError };
  }
  async function saveQueueItemWithProvider(input) {
    // The provider validates the saved job's server and pinned destination itself.
    // Current panel selection must not redirect or block recovery of an existing job.
    if (!await hasPermission()) return { ok: false, error: "Connect to Zotero to grant local access." };
    let result;
    try { result = await provider.saveWebPageWithSnapshot(input); }
    catch (error) { result = { ok: false, error: error.message || "Local Zotero save failed." }; }
    if (!result.ok) {
      if (result.authorizationRequired) await forgetAuthorization();
      const diagnostics = await refreshProviderDiagnostics();
      await saveProviderDiagnostics({ ...diagnostics, lastError: result.error, updatedAt: Date.now() });
    }
    return result;
  }
  return { refreshProviderDiagnostics, resolveSaveProvider, saveQueueItemWithProvider, jobs: provider.jobs };
}

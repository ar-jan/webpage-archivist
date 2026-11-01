import { createLocalProvider } from "../zotero/provider-local.js";
import { readLocalDiagnostics } from "../zotero/diagnostics.js";
import { createLocalClient, LOCAL_PERMISSION } from "../zotero/local-client.js";
import { getLocalSettings, forgetLocalAuthorization } from "../zotero/local-settings.js";

export function createProviderOrchestrator({ saveProviderDiagnostics,
  provider = createLocalProvider(), client = createLocalClient(), getSettings = getLocalSettings,
  forgetAuthorization = forgetLocalAuthorization,
  hasPermission = () => chrome.permissions.contains({ origins: [LOCAL_PERMISSION] }) }) {
  async function refreshProviderDiagnostics() {
    const diagnostics = await readLocalDiagnostics({ client, getSettings, hasPermission });
    await saveProviderDiagnostics(diagnostics);
    return diagnostics;
  }
  async function saveQueueItemWithProvider(input) {
    // The provider validates the saved job's server and pinned destination itself.
    // Current panel selection must not redirect or block recovery of an existing job.
    if (!await hasPermission()) return { ok: false, error: "Connect to Zotero to grant local access." };
    let result;
    try { result = await provider.saveWebPageWithSnapshot(input); }
    catch (error) { result = { ok: false, error: error.message || "Local Zotero save failed." }; }
    if (!result.ok && !input.signal?.aborted) {
      if (result.authorizationRequired) await forgetAuthorization();
      const diagnostics = await refreshProviderDiagnostics();
      await saveProviderDiagnostics({ ...diagnostics, lastError: result.error, updatedAt: Date.now() });
    }
    return result;
  }
  return { refreshProviderDiagnostics, saveQueueItemWithProvider, jobs: provider.jobs };
}

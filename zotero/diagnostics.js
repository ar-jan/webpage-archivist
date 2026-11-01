import { createDefaultProviderDiagnostics } from "./provider-interface.js";
import { createLocalClient, LOCAL_PERMISSION, validateDestination } from "./local-client.js";
import { getLocalSettings } from "./local-settings.js";

export async function readLocalDiagnostics({ client = createLocalClient(), getSettings = getLocalSettings,
  hasPermission = () => chrome.permissions.contains({ origins: [LOCAL_PERMISSION] }) } = {}) {
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
  return diagnostics;
}

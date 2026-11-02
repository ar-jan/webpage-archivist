import { createLocalClient, LOCAL_PERMISSION } from "../zotero/local-client.js";
import { getLocalSettings, saveLocalAuthorization, saveLocalDestination } from "../zotero/local-settings.js";

export function createZoteroController({ connectButton, destinationSelect, setStatus, refresh }) {
  const client = createLocalClient();
  let destinations = [];
  let serverID;
  let loading;
  async function loadDestinations() {
    if (loading) return loading;
    loading = (async () => {
      if (!await chrome.permissions.contains({ origins: [LOCAL_PERMISSION] })) return;
      const health = await client.health();
      const settings = await getLocalSettings();
      if (settings.auth?.serverID !== health.serverID) return;
      serverID = health.serverID;
      destinations = await client.destinations(serverID);
      destinationSelect.replaceChildren();
      for (const [index, destination] of destinations.entries()) {
        const option = document.createElement("option");
        option.value = String(index); option.textContent = destination.label;
        option.selected = destination.libraryPath === settings.destination?.libraryPath && destination.collectionKey === settings.destination?.collectionKey;
        destinationSelect.append(option);
      }
      destinationSelect.disabled = !destinations.length;
    })();
    try { await loading; } finally { loading = null; }
  }
  connectButton.addEventListener("click", async () => {
    // Request permission synchronously from the click's user gesture.
    const permission = chrome.permissions.request({ origins: [LOCAL_PERMISSION] });
    connectButton.disabled = true;
    try {
      if (!await permission) throw new Error("Local Zotero access was not granted.");
      const health = await client.health();
      setStatus("In Zotero, choose Always Allow for Webpage Archivist. Keep this panel open until connected.");
      // An extension page can wait for a human response; a worker fetch cannot.
      const response = await client.authorize(health.serverID);
      await saveLocalAuthorization(health.serverID, response.data);
      await loadDestinations();
      await refresh();
      setStatus("Connected to Zotero. Choose a save destination, then start the queue.");
    } catch (error) { setStatus(error.message); }
    finally { connectButton.disabled = false; }
  });
  destinationSelect.addEventListener("change", async () => {
    try {
      const selected = destinations[Number(destinationSelect.value)];
      if (!selected) return;
      await saveLocalDestination(selected, serverID);
      await refresh();
      setStatus(`New saves will use ${selected.label}. Retries keep their original destination.`);
    } catch (error) { setStatus(error.message); }
  });
  return { loadDestinations };
}

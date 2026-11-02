import { validateDestination } from "./local-client.js";
const AUTH_KEY = "localZoteroAuth";
const DESTINATION_KEY = "localZoteroDestination";

export async function getLocalSettings() {
  const stored = await chrome.storage.local.get([AUTH_KEY, DESTINATION_KEY]);
  return { auth: stored[AUTH_KEY] || null, destination: stored[DESTINATION_KEY] || null };
}

export async function saveLocalAuthorization(serverID, authorization) {
  if (typeof serverID !== "string" || typeof authorization?.key !== "string" || !authorization.key) {
    throw new Error("Invalid Zotero authorization response.");
  }
  if (authorization.remember !== true) {
    throw new Error("Queue saves need multiple requests. Connect again and choose Always Allow in Zotero.");
  }
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const previous = await getLocalSettings();
  await chrome.storage.local.set({
    [AUTH_KEY]: { serverID, key: authorization.key, remember: true },
    [DESTINATION_KEY]: previous.destination?.serverID === serverID ? previous.destination
      : { serverID, libraryPath: "/users/0", collectionKey: "", label: "My Library" }
  });
}

export async function saveLocalDestination(destination, serverID) {
  const validated = validateDestination(destination);
  await chrome.storage.local.set({ [DESTINATION_KEY]: {
    ...validated, serverID, label: String(destination.label || "Zotero destination").slice(0,500)
  } });
}

export async function forgetLocalAuthorization() {
  await chrome.storage.local.remove(AUTH_KEY);
}

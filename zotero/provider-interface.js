import { SAVE_PROVIDER_MODES } from "../shared/protocol.js";

export function createDefaultProviderDiagnostics() {
  return { activeMode: SAVE_PROVIDER_MODES.LOCAL_ZOTERO, permissionGranted: false,
    reachable: false, authorized: false, destinationReady: false, clientVersion: null,
    targetLabel: null, lastError: null, updatedAt: Date.now() };
}

export function normalizeProviderDiagnostics(input) {
  const result = createDefaultProviderDiagnostics();
  for (const key of ["permissionGranted", "reachable", "authorized", "destinationReady"]) result[key] = input?.[key] === true;
  for (const key of ["clientVersion", "targetLabel", "lastError"]) {
    result[key] = typeof input?.[key] === "string" && input[key].trim() ? input[key].trim() : null;
  }
  if (Number.isFinite(input?.updatedAt) && input.updatedAt > 0) result.updatedAt = Math.trunc(input.updatedAt);
  return result;
}

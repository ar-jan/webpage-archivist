import assert from "node:assert/strict";
import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

// Copy the loadable checkout, never local build output or installed dependencies.
export async function copyExtension(destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of ["background", "content", "icons", "shared", "sidepanel", "zotero", "vendor",
    "manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(entry, path.join(destination, entry), { recursive: true });
  }
  for (const entry of ["node_modules", "dist"]) {
    await assert.rejects(access(path.join(destination, entry)), { code: "ENOENT" });
  }
}

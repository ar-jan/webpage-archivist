import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, symlink, access, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

test("the shipped source rebuilds a complete extension without repository vendor files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "archivist-clean-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp("dist/source", root, { recursive: true });
  await assert.rejects(access(path.join(root, "vendor/md5.js")), { code: "ENOENT" });
  await assert.rejects(access(path.join(root, "content/snapshot.bundle.js")), { code: "ENOENT" });
  // Reuse the installed lockfile dependencies, but no generated runtime assets.
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe" });
  for (const file of ["manifest.json", "background/service-worker.js", "content/snapshot.bundle.js",
    "vendor/single-file-hooks.js", "vendor/SparkMD5-LICENSE", "vendor/SingleFile-LICENSE",
    "sidepanel/panel.html", "shared/storage-repo.js", "zotero/diagnostics.js"]) {
    assert.deepEqual(await readFile(path.join(root, "dist", file)), await readFile(path.join("dist", file)), file);
  }
  const worker = await readFile(path.join(root, "dist/background/service-worker.js"), "utf8");
  assert.equal(worker.includes('from "spark-md5"'), false);
  assert.equal(worker.includes('from "../vendor/md5.js"'), false);
});

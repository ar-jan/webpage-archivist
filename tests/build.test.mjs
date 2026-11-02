import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, symlink, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyExtension } from "./test-helpers/extension-copy.mjs";

test("runtime assets rebuild from clean source and freshness checks never repair stale files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "archivist-clean-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyExtension(root);
  for (const entry of ["scripts", "package.json", "package-lock.json"]) {
    await cp(entry, path.join(root, entry), { recursive: true });
  }
  await rm(path.join(root, "vendor"), { recursive: true });
  await rm(path.join(root, "content/snapshot.bundle.js"));
  await rm(path.join(root, "content/snapshot.bundle.js.LEGAL.txt"), { force: true });
  // Reuse only lockfile dependencies: no generated assets are available to build.
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  const run = (...args) => execFileSync(process.execPath, ["scripts/build.mjs", ...args], { cwd: root, stdio: "pipe" });
  run();
  for (const file of ["vendor/md5.js", "content/snapshot.bundle.js", "vendor/single-file-hooks.js",
    "vendor/SparkMD5-LICENSE", "vendor/SingleFile-LICENSE"]) {
    assert.deepEqual(await readFile(path.join(root, file)), await readFile(file), file);
  }
  run("--check");
  for (const file of ["vendor/md5.js", "content/snapshot.bundle.js", "vendor/single-file-hooks.js",
    "vendor/SingleFile-LICENSE", "vendor/single-file-source/single-file.js"]) {
    const target = path.join(root, file);
    const original = await readFile(target);
    await writeFile(target, "stale fixture");
    assert.throws(() => run("--check"), error => error.stderr.toString().includes(file));
    assert.equal(await readFile(target, "utf8"), "stale fixture");
    await rm(target);
    assert.throws(() => run("--check"), error => error.stderr.toString().includes(file));
    await writeFile(target, original);
  }
  await writeFile(path.join(root, "content/snapshot.js"), 'globalThis.staleCaptureFixture = true;\n', { flag: "a" });
  assert.throws(() => run("--check"), error => error.stderr.toString().includes("content/snapshot.bundle.js"));
});

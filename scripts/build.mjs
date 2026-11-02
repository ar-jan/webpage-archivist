import { build } from "esbuild";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { licenseBanner, verifyThirdPartyInputs, writeLicenseNotices } from "./license-assets.mjs";

const check = process.argv.includes("--check");
const snapshotFiles = ["content/snapshot.bundle.js", "content/snapshot.bundle.js.LEGAL.txt"];
const thirdParty = await verifyThirdPartyInputs();
// Build in isolation so checks cannot silently repair stale committed assets.
const stage = await mkdtemp(path.resolve(".runtime-build-"));
try {
  const inputs = new Set();
  const bundle = async (entry, outfile, format, singleFile = true) => {
    const result = await build({
      entryPoints: [entry], bundle: true, format, target: "chrome120", preserveSymlinks: true,
      outfile: path.join(stage, outfile), legalComments: "linked", metafile: true,
      banner: { js: licenseBanner(outfile, singleFile) },
    });
    for (const file of Object.keys(result.metafile.inputs)) inputs.add(file);
  };
  await bundle("content/snapshot.js", "content/snapshot.bundle.js", "iife");
  await bundle("node_modules/single-file-core/single-file-hooks-frames.js", "vendor/single-file-hooks.js", "iife");
  await bundle("node_modules/spark-md5/spark-md5.js", "vendor/md5.js", "esm", false);
  await copyFile("node_modules/single-file-core/LICENSE", path.join(stage, "vendor/SingleFile-LICENSE"));
  await copyFile("third-party/licenses/spark-md5-MIT.txt", path.join(stage, "vendor/SparkMD5-LICENSE"));
  // Keep upstream source and embedded notices alongside the browser bundles.
  await cp("node_modules/single-file-core", path.join(stage, "vendor/single-file-source"), { recursive: true });
  await cp("node_modules/spark-md5", path.join(stage, "vendor/spark-md5-source"), { recursive: true });
  await copyFile("third-party/licenses/spark-md5-MIT.txt", path.join(stage, "vendor/spark-md5-source/LICENSE2"));
  await writeLicenseNotices(stage, thirdParty, inputs);

  if (check) {
    const files = new Set([
      ...await listFiles(path.join(stage, "vendor"), "vendor"),
      ...await listFiles("vendor", "vendor"),
      ...snapshotFiles,
    ]);
    const stale = [];
    for (const file of [...files].sort()) {
      const expected = await readOptional(path.join(stage, file));
      const actual = await readOptional(file);
      if (expected === null ? actual !== null : actual === null || !expected.equals(actual)) stale.push(file);
    }
    if (stale.length) {
      throw new Error(`Runtime assets are missing or stale:\n${stale.join("\n")}\nRun npm run build and commit the regenerated assets.`);
    }
    console.log("Committed runtime assets match the pinned dependencies and snapshot source.");
  } else {
    // Only replace generated assets after every bundle/source copy has succeeded.
    await rm("vendor", { recursive: true, force: true });
    await rename(path.join(stage, "vendor"), "vendor");
    await mkdir("content", { recursive: true });
    for (const file of snapshotFiles) {
      await rm(file, { force: true });
      if (await readOptional(path.join(stage, file)) !== null) await rename(path.join(stage, file), file);
    }
    console.log("Regenerated runtime assets. Commit vendor/ and content/snapshot.bundle.js* together with source changes.");
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function readOptional(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function listFiles(directory, prefix) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

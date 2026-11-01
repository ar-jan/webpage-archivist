import { build } from "esbuild";
import { mkdir, copyFile, cp, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

// Publish only a complete build. The browser loads dist/, never the source tree.
const output = path.resolve("dist");
const stage = await mkdtemp(path.resolve(".dist-build-"));
try {
  for (const entry of ["sidepanel", "shared", "icons"]) {
    await cp(entry, path.join(stage, entry), { recursive: true });
  }
  await mkdir(path.join(stage, "zotero"));
  for (const file of ["local-client.js", "local-settings.js", "provider-interface.js", "diagnostics.js"]) {
    await copyFile(`zotero/${file}`, path.join(stage, "zotero", file));
  }
  await mkdir(path.join(stage, "content"));
  await copyFile("content/collector.js", path.join(stage, "content/collector.js"));
  for (const file of ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await copyFile(file, path.join(stage, file));
  }
  const bundle = (entry, outfile, format) => build({
    entryPoints: [entry], bundle: true, format, target: "chrome120", preserveSymlinks: true,
    outfile: path.join(stage, outfile), legalComments: "linked"
  });
  await bundle("background/service-worker.js", "background/service-worker.js", "esm");
  await bundle("content/snapshot.js", "content/snapshot.bundle.js", "iife");
  await bundle("node_modules/single-file-core/single-file-hooks-frames.js", "vendor/single-file-hooks.js", "iife");
  await copyFile("node_modules/single-file-core/LICENSE", path.join(stage, "vendor/SingleFile-LICENSE"));
  await copyFile("node_modules/spark-md5/LICENSE", path.join(stage, "vendor/SparkMD5-LICENSE"));
  for (const name of ["single-file-core", "spark-md5"]) {
    await cp(`node_modules/${name}`, path.join(stage, "vendor", `${name}-source`), { recursive: true });
  }
  // Ship corresponding application source and the reproducible build recipe.
  for (const entry of ["background", "content", "shared", "sidepanel", "zotero", "scripts", "icons",
    "manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await cp(entry, path.join(stage, "source", entry), {
      recursive: true,
      filter: file => !file.endsWith("snapshot.bundle.js") && !file.endsWith("snapshot.bundle.js.LEGAL.txt")
    });
  }
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  console.log(`Built ${output}`);
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}

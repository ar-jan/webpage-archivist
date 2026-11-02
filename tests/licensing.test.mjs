import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

test("runtime bundles link explicit notices with nested attribution and full license texts", async () => {
  const notices = await readFile("vendor/THIRD_PARTY_LICENSES.txt", "utf8");
  for (const name of ["Gildas Lormeau", "Arjun Barrett", "Mozilla Foundation and contributors",
    "Roman Dvornov", "OpenJS Foundation", "André Cruz", "Jed Mao", "Ben Briggs", "Domenic Denicola"]) {
    assert.ok(notices.includes(name), `Missing attribution: ${name}`);
  }
  assert.ok(notices.includes(await readFile("LICENSE", "utf8")));
  assert.ok(notices.includes(await readFile("LICENSE-MIT", "utf8")));
  const manifest = JSON.parse(await readFile("third-party/manifest.json", "utf8"));
  for (const file of manifest.files.filter(file => file.group)) {
    assert.ok(notices.includes(await readFile(`third-party/${file.path}`, "utf8")), file.path);
  }
  for (const file of ["content/snapshot.bundle.js", "vendor/single-file-hooks.js", "vendor/md5.js"]) {
    const bundle = await readFile(file, "utf8");
    assert.ok(bundle.startsWith("/*! Webpage Archivist"));
    assert.ok(bundle.includes(file.split("/").at(-1) + ".LEGAL.txt"));
    const sidecar = await readFile(`${file}.LEGAL.txt`, "utf8");
    assert.ok(sidecar.includes(file.includes("md5") ? "André Cruz" : "GNU AFFERO GENERAL PUBLIC LICENSE"));
  }
  assert.deepEqual(await readFile("vendor/SparkMD5-LICENSE"), await readFile("third-party/licenses/spark-md5-MIT.txt"));
  assert.deepEqual(await readFile("vendor/spark-md5-source/LICENSE2"), await readFile("vendor/SparkMD5-LICENSE"));
});

test("source archives include preferred source and the nested rebuild recipes omitted by npm", async () => {
  // Read tar headers only; do not extract or execute anything from the archives.
  async function members(file) {
    const bytes = gunzipSync(await readFile(`third-party/sources/${file}`));
    const names = [];
    for (let offset = 0; offset + 512 <= bytes.length && bytes[offset];) {
      const name = bytes.toString("utf8", offset, offset + 100).split("\0")[0];
      const size = parseInt(bytes.toString("ascii", offset + 124, offset + 136).replace(/\0/g, "").trim(), 8) || 0;
      names.push(name.split("/").slice(1).join("/"));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return names;
  }
  const singleFile = await members("single-file-core-1.8.0.tar.gz");
  for (const file of ["css-tree-build/build.js", "css-tree-build/package-lock.json", "zip-build/package-lock.json",
    "zip-build/rollup.config.js", "zip-build/lib/fflate.js", "zip-build/reserved-property-names.json"]) {
    assert.ok(singleFile.includes(file), `Missing rebuild input: ${file}`);
  }
  assert.ok((await members("fflate-0.8.3.tar.gz")).includes("src/index.ts"));
  for (const file of ["eslint-css-tree-4.1.1.tgz", "source-map-js-1.2.1.tgz", "zip-js-2.23.0.tgz"]) {
    const names = await members(file);
    assert.ok(names.includes("LICENSE"), file);
    assert.ok(names.some(name => name.startsWith("lib/") && name.endsWith(".js")), file);
  }
});

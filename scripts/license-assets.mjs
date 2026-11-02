import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyThirdPartyInputs() {
  const manifest = JSON.parse(await readFile("third-party/manifest.json", "utf8"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (pkg.dependencies[name] !== version) throw new Error(`Refresh third-party sources and notices for ${name} ${pkg.dependencies[name]}.`);
    const installed = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
    if (installed.version !== version) throw new Error(`Run npm ci: installed ${name} does not match the audited version ${version}.`);
  }
  for (const file of manifest.files) {
    const bytes = await readFile(path.join("third-party", file.path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Third-party input checksum mismatch: ${file.path}. Restore the pinned input or audit and record its replacement.`);
    }
  }
  const agpl = await readFile("node_modules/single-file-core/LICENSE");
  if (!agpl.equals(await readFile("LICENSE"))) throw new Error("LICENSE must preserve the complete upstream AGPL text.");
  return manifest;
}

export function licenseBanner(outfile, singleFile) {
  return `/*! Webpage Archivist — ${singleFile ? "AGPL-3.0-or-later" : "SparkMD5 under MIT"}.
 * Copyright and license texts: ${path.basename(outfile)}.LEGAL.txt
 * Corresponding source, build instructions and dated changes: ../LICENSING.md
 * Upstream source archives and provenance: ../third-party/README.md
 */`;
}

export async function writeLicenseNotices(stage, manifest, inputs) {
  const sections = [
    await readFile("LICENSING.md", "utf8"),
    await readFile("THIRD_PARTY_NOTICES.md", "utf8"),
    `GNU Affero General Public License, version 3\n\n${await readFile("LICENSE", "utf8")}`,
    `Archivist original source — separate MIT grant\n\n${await readFile("LICENSE-MIT", "utf8")}`,
  ];
  for (const file of manifest.files.filter(file => file.group)) {
    sections.push(`${file.path}\n\n${await readFile(path.join("third-party", file.path), "utf8")}`);
  }
  // esbuild recognizes only specially marked legal comments. Collect the plain
  // upstream copyright/license blocks as well, without modifying upstream code.
  const notices = new Map();
  for (const file of [...inputs].sort()) {
    const source = await readFile(file, "utf8");
    for (const [comment] of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (!/copyright|@license|@preserve|permission is hereby|redistribution and use/i.test(comment)) continue;
      const text = comment.replace(/\r\n/g, "\n");
      const files = notices.get(text) || [];
      files.push(file.replace(/^node_modules\//, ""));
      notices.set(text, files);
    }
  }
  for (const [notice, files] of notices) sections.push(`Upstream notices: ${files.join(", ")}\n\n${notice}`);
  const all = sections.join("\n\n----------------------------------------\n\n") + "\n";
  await writeFile(path.join(stage, "vendor/THIRD_PARTY_LICENSES.txt"), all);
  for (const file of ["content/snapshot.bundle.js", "vendor/single-file-hooks.js"]) {
    const target = path.join(stage, `${file}.LEGAL.txt`);
    // Preserve any additional notices recognized by esbuild in future versions.
    const extra = await readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    await writeFile(target, all + extra);
  }
  const md5Notice = path.join(stage, "vendor/md5.js.LEGAL.txt");
  const md5Extra = await readFile(md5Notice, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  await writeFile(md5Notice,
    `SparkMD5 3.0.2 — distributed under its MIT alternative.\nSource: vendor/spark-md5-source/\n\n${await readFile("third-party/licenses/spark-md5-MIT.txt", "utf8")}\n${md5Extra}`);
}

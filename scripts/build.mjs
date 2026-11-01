import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";

await mkdir("vendor", { recursive: true });
await build({ entryPoints: ["content/snapshot.js"], bundle: true, format: "iife", target: "chrome120", outfile: "content/snapshot.bundle.js", legalComments: "linked" });
await build({ entryPoints: ["node_modules/single-file-core/single-file-hooks-frames.js"], bundle: true, format: "iife", target: "chrome120", outfile: "vendor/single-file-hooks.js", legalComments: "linked" });
await build({ entryPoints: ["node_modules/spark-md5/spark-md5.js"], bundle: true, format: "esm", outfile: "vendor/md5.js", legalComments: "inline" });
await copyFile("node_modules/single-file-core/LICENSE", "vendor/SingleFile-LICENSE");

// Keep corresponding source and embedded third-party notices with the local build.
await cp("node_modules/single-file-core", "vendor/single-file-source", { recursive: true });
await cp("node_modules/spark-md5", "vendor/spark-md5-source", { recursive: true });

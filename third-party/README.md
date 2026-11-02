# Third-party source and provenance

These are checked-in build inputs and source archives, not generated output.
Normal installation, updates, builds and asset checks do not download these files.
`manifest.json` records each imported file's origin and SHA-256 digest; npm source
archives also retain the SHA-512 integrity from SingleFile's upstream lockfiles.
License texts extracted from archives record the archive and member path.

## Source inventory

| File in `sources/` | Contents and purpose |
| --- | --- |
| `single-file-core-1.8.0.tar.gz` | Complete upstream repository at `1c607a58011e50b9fa579100a8a9d3d139a10d0a`, including `css-tree-build/` and `zip-build/`, patches, source entries, lockfiles and build configuration omitted by npm |
| `eslint-css-tree-4.1.1.tgz` | Readable CSS-tree library sources/data used by the patched upstream build |
| `mdn-data-2.35.0.tgz` | CSS data consumed by CSS-tree, under CC0-1.0 |
| `source-map-js-1.2.1.tgz` | Readable source-map library sources used by CSS-tree, under BSD-3-Clause |
| `zip-js-2.23.0.tgz` | Readable zip.js library sources used by the customized upstream ZIP builds |
| `fflate-0.8.3.tar.gz` | Upstream repository at the resolved v0.8.3 commit recorded in the manifest, including original TypeScript source and its build scripts |

The first and last archives use GitHub repository layout (one top-level directory).
The `.tgz` files use npm layout (`package/`). Extract with a tar/gzip reader;
`--strip-components=1` removes that wrapper. Do not edit imported archives or
license texts in place. The application-specific snapshot adapter and its build
are in the repository root, not inside these upstream archives.

SparkMD5's readable source is in `../vendor/spark-md5-source/`. Its additional MIT
license was retrieved from the exact published commit
`9315385868fe11076674d4ddd763005319a462a7`. SingleFile's readable published source
is in `../vendor/single-file-source/`. The embedded Public Suffix List source and
MPL notice are in that directory's `modules/template-formatter.js`.

## Rebuild the extension bundles

From the repository root, with Node.js 24+:

```sh
npm ci
npm run build
npm run check:assets
```

`build` verifies the pinned supplemental inputs before generating bundles and
notices. `check:assets` compares a temporary build without changing the checkout.
General-purpose build tools are installed through the lockfiles; they are not
extension runtime dependencies.

## Rebuild SingleFile's embedded dependencies

The outer extension build consumes SingleFile's published embedded bundles.
To rebuild those embedded bundles from their original inputs instead, start at
the repository root on a system with Node.js, npm, tar and cmp:

```sh
mkdir -p .source-rebuild/single-file-core
tar -xzf third-party/sources/single-file-core-1.8.0.tar.gz \
  -C .source-rebuild/single-file-core --strip-components=1
npm cache add third-party/sources/*.tgz
cd .source-rebuild/single-file-core/css-tree-build
npm ci
npm run build
cd ../zip-build
npm ci
npm run build
cd ../../..
cmp .source-rebuild/single-file-core/vendor/css-tree.js vendor/single-file-source/vendor/css-tree.js
cmp .source-rebuild/single-file-core/vendor/zip/zip.js vendor/single-file-source/vendor/zip/zip.js
cmp .source-rebuild/single-file-core/vendor/zip/zip.min.js vendor/single-file-source/vendor/zip/zip.min.js
cmp .source-rebuild/single-file-core/vendor/zip/z-worker.js vendor/single-file-source/vendor/zip/z-worker.js
```

All four comparisons were verified for this pinned revision. The source archive's
two build READMEs explain the patches and ZIP customizations. npm may download
general-purpose build tools; the pinned runtime source packages are included here.
The fflate archive supplies its original TypeScript and build recipe in addition
to the readable JavaScript embedded by SingleFile's ZIP build.

## Updating dependencies

Update the runtime version and lockfile, then audit the new upstream dependency
tree, embedded notices and build inputs. Retrieve the corresponding source
archives and license texts; record immutable revisions, URLs and hashes in
`manifest.json`. Update the component inventory,
rebuild the nested bundles to verify their sources, and run `npm run build` and
`npm test`. Commit the source inputs, notices and generated outputs together.

The manifest's hashes detect missing or altered inputs. They do not independently
establish license completeness: new dependencies and upstream changes still need
review. Generated `vendor/` files are recreated from these inputs and npm packages.

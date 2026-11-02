# Third-party components

The combined extension is distributed under **AGPL-3.0-or-later**, with a separate
MIT grant for Archivist's original source. See [LICENSING.md](LICENSING.md),
[LICENSE](LICENSE), and [LICENSE-MIT](LICENSE-MIT). Component copyright notices
and licenses remain in force. Full texts and preserved upstream headers are
collected in [vendor/THIRD_PARTY_LICENSES.txt](vendor/THIRD_PARTY_LICENSES.txt).

- **SingleFile Core 1.8.0**, copyright Gildas Lormeau and contributors.
  **AGPL-3.0-or-later**, with the additional permission preserved in its source
  headers. [Pinned upstream source](https://github.com/gildas-lormeau/single-file-core/tree/1c607a58011e50b9fa579100a8a9d3d139a10d0a).
- **SparkMD5 3.0.2**, copyright 2015 André Cruz; distributed under the **MIT**
  alternative offered by its `(WTFPL OR MIT)` metadata.
  [Pinned upstream license](https://github.com/satazor/js-spark-md5/blob/9315385868fe11076674d4ddd763005319a462a7/LICENSE2).
  The MIT text is in `vendor/SparkMD5-LICENSE` and `vendor/spark-md5-source/LICENSE2`;
  the original WTFPL text remains in `vendor/spark-md5-source/LICENSE`.
  Used for Zotero's required MD5 transfer checksum, not for authentication.

## Components embedded by SingleFile

- **@eslint/css-tree 4.1.1**: MIT; copyright Roman Dvornov, OpenJS Foundation and
  contributors. SingleFile applies four patches, preserved in the source archive's
  `css-tree-build/`. Includes **mdn-data 2.35.0** (CC0-1.0) and
  **source-map-js 1.2.1** (BSD-3-Clause; copyright 2009–2011 Mozilla Foundation and
  contributors). Their complete license texts are in `third-party/licenses/`.
- **@zip.js/zip.js 2.23.0**: BSD-3-Clause; copyright Gildas Lormeau. SingleFile's
  custom builds include **fflate 0.8.3** (MIT; copyright 2026 Arjun Barrett).
  Full texts are `third-party/licenses/zip-js-BSD.txt` and `fflate-MIT.txt`.
- **Public Suffix List**: MPL-2.0. Its source and notice are embedded in
  `vendor/single-file-source/modules/template-formatter.js`; the full license is
  `third-party/licenses/MPL-2.0.txt`. The exact list snapshot is retained with the
  pinned SingleFile sources rather than replaced with today's list.
- SingleFile also includes MIT-licensed CSS font-property, media-query and
  unescape parsers, an HTML srcset parser and a MIME-type parser. The original
  headers credit Jed Mao, Ben Briggs, Alex Bell and Domenic Denicola where supplied.
  Their complete supplied notices are retained in `vendor/single-file-source/vendor/`
  and copied into the generated notice files. Other SingleFile source headers and
  attributions are retained alongside their corresponding source files.

## Source, builds and notices

`npm ci && npm run build` reproduces the local bundles from `package-lock.json`
and the checked-in supplemental inputs. Every runtime bundle has an explicit
license banner and a `.LEGAL.txt` sidecar. The SingleFile sidecars include notices
for the complete shipped dependency distribution, even for code paths not enabled
by Archivist. esbuild-recognized legal comments are also preserved.

Readable npm-package source is in `vendor/single-file-source` and
`vendor/spark-md5-source`. The npm package alone omits some preferred source/build
inputs: matching upstream archives, nested dependency source and checksummed
provenance are provided in `third-party/`. See its [rebuild instructions](third-party/README.md).
Archivist's own source, build recipe and lockfile are in this repository.

`npm run check:assets` verifies supplemental input hashes and compares generated
bundles and notices without repairing the checkout. Keep source and notices
together when sharing the extension. No executable dependency is fetched at
extension runtime. Build/test tools installed by npm are not shipped runtime code.

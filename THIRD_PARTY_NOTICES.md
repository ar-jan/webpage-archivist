# Third-party components

Archivist's original source remains under the repository's MIT license. The
snapshot build includes SingleFile, which is licensed under **AGPL-3.0-or-later**.
A distribution containing that component must comply with its license; the
repository's MIT license does not replace the dependency's terms.

- **SingleFile Core 1.8.0**, copyright Gildas Lormeau and contributors.
  [Upstream source](https://github.com/gildas-lormeau/single-file-core),
  [license](https://github.com/gildas-lormeau/single-file-core/blob/main/LICENSE).
  The pinned npm package includes its own embedded third-party notices.
- **SparkMD5 3.0.2**, copyright André Cruz and contributors; MIT option of
  `(WTFPL OR MIT)`. [Upstream source](https://github.com/satazor/js-spark-md5).
  Used for Zotero's required MD5 transfer checksum, not for authentication.

`npm ci && npm run build` reproduces the local bundles from `package-lock.json`.
The build copies the complete installed SingleFile and SparkMD5 source packages
and their notices into `vendor/single-file-source` and `vendor/spark-md5-source`,
and copies SingleFile's license to `vendor/SingleFile-LICENSE`. Keep these files,
this notice, and the Archivist source/build recipe with a distributed extension.
No executable dependency is fetched at extension runtime.

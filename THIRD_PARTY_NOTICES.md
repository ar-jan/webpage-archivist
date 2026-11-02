# Third-party components

Archivist's original source remains under the repository's MIT license. The
snapshot build includes SingleFile, which is licensed under **AGPL-3.0-or-later**.
A distribution containing that component must comply with its license; the
repository's MIT license does not replace the dependency's terms.

- **SingleFile Core 1.8.0**, copyright Gildas Lormeau and contributors.
  [Upstream source](https://github.com/gildas-lormeau/single-file-core),
  [license](https://github.com/gildas-lormeau/single-file-core/blob/main/LICENSE).
  The pinned npm package includes its own embedded third-party notices.
- **SparkMD5 3.0.2**, copyright André Cruz and contributors; package metadata offers
  `(WTFPL OR MIT)`. [Upstream source](https://github.com/satazor/js-spark-md5).
  The package's supplied license is included in `vendor/SparkMD5-LICENSE`.
  Used for Zotero's required MD5 transfer checksum, not for authentication.

`npm ci && npm run build` reproduces the local bundles from `package-lock.json`.
SparkMD5 is bundled into `vendor/md5.js`. The snapshot adapter and SingleFile are
bundled into `content/snapshot.bundle.js`, with hooks in `vendor/single-file-hooks.js`.
These generated browser-ready files are checked into Git so the repository root
can be loaded without a build.
The complete installed SingleFile and SparkMD5 source packages and their notices
are checked in at `vendor/single-file-source` and `vendor/spark-md5-source`, with
SingleFile's license at `vendor/SingleFile-LICENSE`. Archivist's application source,
build recipe and lockfile are present in the repository itself. Keep the source
and notices together when sharing the checkout. `npm run check:assets` verifies
that all these generated files match the pinned dependencies and snapshot source.
No executable dependency is fetched at extension runtime.

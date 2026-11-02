# License scope and modifications

Copyright (c) 2026 Arjan Mossel and the respective third-party copyright holders.

Webpage Archivist, including its integration with SingleFile, is distributed as
a combined work under the GNU Affero General Public License, version 3 or (at
your option) any later version (**AGPL-3.0-or-later**). The complete license is in
[LICENSE](LICENSE). You may copy, redistribute and modify this combined work
under those terms. It is provided without warranty, including any implied
warranty of merchantability or fitness for a particular purpose.

Archivist's original application code, tests, build scripts and documentation
are also separately offered under the MIT grant in [LICENSE-MIT](LICENSE-MIT).
That grant does not relicense SingleFile or other third-party material, and does
not make the combined extension MIT-only. Generated bundles contain code under
multiple component licenses; preserve all of their notices when distributing
them. Third-party source and archives retain their original license terms.

SingleFile source headers include an additional permission for distributing
unmodified files without a separate AGPL copy when the specified notice and
source URL accompany them. Those headers are preserved. We distribute the full
AGPL text and source materials and do not rely on that exception for our bundles.

The [component inventory](THIRD_PARTY_NOTICES.md) identifies component licenses.
SparkMD5 is distributed under its MIT alternative; its original WTFPL text is
retained in the unchanged npm-package source, alongside the added upstream MIT
`LICENSE2`. The Public Suffix List retains its MPL-2.0 terms and source notice.

## Corresponding source

The matching application source is present in this checkout (`background/`,
`content/snapshot.js`, `shared/`, `sidepanel/`, and `zotero/`). The build scripts,
package manifest and lockfile are also included. Readable dependency files are
in `vendor/`; additional pinned source archives, upstream build recipes, patches
and lockfiles are in `third-party/sources/`. See the
[source and rebuild instructions](third-party/README.md).

Keep these materials together when sharing the extension. Do not distribute just
the three runtime bundles without their notices and access to the corresponding
source. The generated `vendor/THIRD_PARTY_LICENSES.txt` and each bundle's
`.LEGAL.txt` file include copyright notices, license texts and these directions.

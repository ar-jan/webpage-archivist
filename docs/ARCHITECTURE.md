# Webpage Archivist Architecture

## 1. Status and scope

This document distinguishes the **implemented extension** from a **proposed local
Zotero provider** investigated on 2026-11-01. The local provider is not implemented.
No manifest, runtime, or dependency changes accompany this design.

The current extension collects and curates links successfully, but its only save
provider, `connector_bridge`, is incompatible with installed Zotero Connector
5.0.217. The proposed replacement would capture pages itself and communicate with
Zotero Desktop over loopback HTTP. The official browser Connector would no longer
be required for Archivist's saves.

Evidence baseline:

- Archivist commit `d64c034` and the runtime modules in this repository.
- Connector tag `5.0.217`, commit
  `ce29dfa360d1ce17a3a1f15a9d338d638a073106`, and the installed extension.
- Zotero tag `10.0.6`, commit
  `536244c2771f590abab9c09a3c27e615e0b318ff`, read from the supplied bare repository.
- A running Zotero 10.0.6 instance and Chromium 156.0.8078.79.

Live checks confirmed health, destination metadata, and error contracts. No library
items were created during this investigation. Upstream save tests and source code
support the proposed write sequence; an end-to-end Archivist implementation still
needs the validation in section 12.

## 2. Implemented architecture

| Surface | Modules | Responsibility |
| --- | --- | --- |
| MV3 service worker | `background/service-worker.js`, `message-router.js` | Initialization, runtime messages, browser events, collection orchestration |
| Queue | `background/queue-engine.js`, `queue-lifecycle.js` | One active tab/item, pacing, lifecycle commands, watchdog and recovery |
| Persistence | `background/storage-repo.js`, `shared/state.js` | Normalize durable state and migrate existing values |
| Side panel | `sidepanel/panel.js`, `actions.js`, `store.js`, `render.js`, focused controllers | Selector rules, collection, selection, queue controls and diagnostics |
| Collector | `content/collector.js` | On-demand selector evaluation, HTTP(S) URL extraction, deduplication and bounded scrolling |
| Provider | `background/provider-orchestrator.js`, `zotero/provider-interface.js`, `provider-connector-bridge.js` | Health checks and saving through the Connector's private iframe transport |
| Contracts | `shared/protocol.js` | Message types, storage keys, provider modes and common validation |

### Browser integration and permissions

`manifest.json` declares `storage`, `alarms`, `tabs`, `scripting`, and `sidePanel`.
HTTP(S) host permissions are optional and requested per origin. There is no
always-on collector, build step, or bundled snapshot library. The toolbar action
opens the native side panel.

### State and flows

Durable `chrome.storage.local` keys are `selectorRules`, `collectedLinks`,
`collectorSettings`, `queueSettings`, `queueItems`, `queueRuntime`, and
`providerDiagnostics`. No page snapshot payloads are currently stored.

Queue item statuses are `pending`, `opening_tab`, `saving_snapshot`, `archived`,
`failed`, and `cancelled`. Runtime statuses are `idle`, `running`, and `paused`.
There is one active item/tab, with default inter-item delay 5 seconds and jitter
2 seconds. Collection defaults to 500 links and optional bounded auto-scrolling.

Collection requests permission, injects the collector into the active page, and
persists normalized results. Selection is persisted; queue authoring deduplicates
against queued URLs. Start/resume preflights permissions for queued URLs. The
engine opens a background tab, waits for completion, calls the provider, marks
success/failure, closes the tab, and advances after the pacing delay.

The queue has recovery hooks for worker startup, tab updates/removal, and a
watchdog alarm. **These do not guarantee exactly-once external saves.** The engine
can call the provider again for an already-`saving_snapshot` item after restart;
its in-memory promise chain cannot survive worker termination. This matters for
the new provider's multi-request writes.

`GET_PANEL_STATE` refreshes integration diagnostics. The current diagnostics model
is specific to Connector/bridge/app availability. Existing Node tests use browser
and provider mocks; the bridge mock substitutes `executeScript` results without
executing the iframe code.

## 3. Why the existing provider broke

Archivist loads `chromeMessageIframe/messageIframe.html` from the Connector,
opens a `MessageChannel`, and asks the iframe to forward `inject-message` commands
to the Connector service worker. Commands include `Connector.checkIsOnline`,
`Connector_Browser.injectTranslationScripts`, and `Messaging.sendMessage` with
`saveAsWebpage`.

Connector commit [`7f618c2`][bridge-removal], **Remove dead messaging-via-iframe
codepath**, committed 2026-06-30, deleted the iframe files, their web-accessible
resource declaration, and the service-worker receiver. The first containing tag
in the supplied checkout is 5.0.211, dated 2026-07-22. The transport had originally
handled large internal messages; the Connector had moved that traffic to chunked
runtime messages.

A new iframe URL cannot repair this removal. Current Connector messaging is
internal; there is no external save handler for Archivist to call. Archivist also
misclassifies iframe/channel failures as an unavailable Connector extension.

Zotero Desktop is reachable. Its local ping returned HTTP 200 with
`X-Zotero-Version: 10.0.6` and `X-Zotero-Connector-API-Version: 3`. The failure is
before Desktop communication.

## 4. Proposed provider and scope

Add a `local_zotero` provider using
`http://127.0.0.1:23119/connector/`, backed by an Archivist-owned capture adapter.
Use the desktop **Connector HTTP API**, which is separate from the browser
extension and from Zotero 10's authenticated `/api/` interface.

This is the smallest replacement for the current “Web Page with Snapshot” mode.
It preserves the desktop-selected destination behavior without requiring a
Connector fork, Zotero plugin, account, or cloud API key. It still depends on a
versioned desktop protocol, so tested Desktop versions and contract fixtures must
be maintained. API version 3 alone does not prove every version has identical
behavior.

Initial scope:

- Loaded HTML pages, generic webpage metadata, and an actual self-contained HTML
  attachment. Keep authenticated page state in the browser capture workflow.
- One capture/save job at a time, independent of whether the side panel stays open.
- The currently selected writable Zotero library/collection, resolved immediately
  before creating each parent item.
- No translator execution, PDF/EPUB import, automatic cloud fallback, or silent
  downgrade to URL-only saving. Unsupported content types get explicit errors.
- Conservative handling of uncertain writes. Unattended, duplicate-free recovery
  across all crashes is **not** provided by this protocol; section 11 describes a
  stronger alternative.

## 5. Desktop HTTP contract

The following contract is derived from Zotero **10.0.6**, not old endpoint comments
or assumptions from the browser Connector. See [server handlers][server-connector],
[save sessions][save-session], and [upstream save tests][connector-tests].

### Transport and health

Own all localhost requests in an extension context, initially the service worker.
Never ask page scripts to issue Zotero requests. Fix the base URL to
`http://127.0.0.1:23119/`; restrict methods and paths to the supported operations and
reject redirects. A future configurable port must remain loopback-only.

Send JSON requests with:

```text
Content-Type: application/json
X-Zotero-Connector-API-Version: 3
```

Read `X-Zotero-Version` and `X-Zotero-Connector-API-Version` on responses and require
the expected protocol identity. The official Connector also sends its version in
`X-Zotero-Version`; do not impersonate its version. Archivist can omit that request
header and use its own identity in diagnostics. Header behavior must be included
in browser integration tests.

The desktop server checks browser-origin requests for the Connector API header.
Host permission and that header are distinct requirements. Health should use
`POST /connector/ping` with `{}` and parse the preferences JSON; a GET is also a
useful diagnostic but returns HTML, not the preferences object. This route does
not require a Zotero account or local API authorization key. See [server request
handling][server] and [Connector HTTP server documentation][http-server-docs].

| Operation | Request body | Expected result in 10.0.6 |
| --- | --- | --- |
| `POST /connector/ping` | `{}` | 200; JSON `prefs`, version headers |
| `POST /connector/getSelectedCollection` | `{"switchToReadableLibrary":false}` | 200; `libraryID`, `id` (collection ID or null), names, `libraryEditable`, `filesEditable`, `editable`, plus targets/tags |
| `POST /connector/saveSnapshot` | `sessionID`, `url`, `title` | 201; parent webpage created; body can be empty despite JSON content type |
| `POST /connector/saveSingleFile` | Same `sessionID` and exact `url`, `title`, nonempty `snapshotContent` | 201 after importing the HTML attachment; body can be empty |
| `POST /connector/updateSession` | `sessionID`, `target` such as `L1`/`C23`, optional tags/note | 200; moves/updates items and changes desktop selection; not part of the initial save flow |

Use the actual returned identifiers. Connector target IDs such as `C23` are local
tree IDs, not the collection keys used by the Web/local `/api/` interface.
Do not persist the whole target/tag response when only current destination metadata
is needed.

### Save sequence

Capture and validate the complete HTML **before creating anything in Zotero**.
Generate a unique session ID per save attempt and persist it before the first write.
Use the captured final page URL consistently for both writes; Zotero indexes the
session's parent item by that exact URL.

```json
{
  "sessionID": "archivist-<attempt-uuid>",
  "url": "https://example.org/article",
  "title": "Article title"
}
```

After the parent request returns 201, upload:

```json
{
  "sessionID": "archivist-<same-attempt-uuid>",
  "url": "https://example.org/article",
  "title": "Article title",
  "snapshotContent": "<!doctype html><html>...self-contained captured page...</html>"
}
```

`saveSnapshot` only creates the webpage item in this version. It does not fetch the
URL or turn raw `outerHTML` into a snapshot. `saveSingleFile` writes the supplied
HTML as an imported `text/html` attachment and awaits the import before returning
201. Neither response provides a durable item key for later reconciliation.

```mermaid
sequenceDiagram
  participant Q as Queue / local provider
  participant T as Queue tab / capture adapter
  participant Z as Zotero Desktop
  Q->>Z: ping + destination preflight
  Q->>T: Capture authorized final document
  T-->>Q: Bounded HTML chunks + capture metadata
  Q->>Q: Persist payload and save attempt
  Q->>Z: Recheck destination; saveSnapshot(sessionID, url, title)
  Z-->>Q: 201 parent created
  Q->>Q: Persist parent-created receipt
  Q->>Z: saveSingleFile(sessionID, url, title, snapshotContent)
  Z-->>Q: 201 attachment imported
  Q->>Q: Persist completion, mark archived, clean up
```

### Completion and destination caveats

- Require **201 from both writes**, not just `response.ok`. `saveSingleFile` can
  return **200 with `Library files are not editable.` without saving a file**.
  Preflight both item and file editability; do not claim this is success.
- Parse response bodies conditionally. Do not call `response.json()` on an empty
  successful response simply because its content type says JSON.
- There is **no `/connector/sessionProgress` endpoint in 10.0.6**. A live probe
  returned 404. Do not design completion around older polling examples.
- Destination selection is mutable. `saveSnapshot` resolves it at creation time;
  `saveSingleFile` also checks current destination file editability. Preflight and
  recheck near each write, but do not promise an atomically pinned destination.
  Pause on an observed change after parent creation. A fixed destination picker
  is a separate feature, better served by section 11's explicit library API.
- A parent may remain after an attachment failure. Report that partial result;
  do not silently create a replacement parent or delete library items to hide it.

## 6. Snapshot capture is a first-class component

Bundle and pin a browser snapshot engine behind `snapshot-capture.js`. SingleFile
is the leading candidate because the Connector itself uses
`singlefile.getPageData(...).content`; its wrapper illustrates resource fetching,
page-world hooks and lazy-loading handling. Implement Archivist's adapter against
a pinned upstream build instead of importing files from another installed
extension. See [Connector snapshot capture][singlefile-adapter].

Dependency selection is still open: the local Connector bundle and upstream
[single-file-core][singlefile-core] carry AGPL-3.0 licensing, while this repository
currently has an MIT license. Decide the dependency/distribution licensing approach
before vendoring code, retain notices and record the exact revision and build
recipe. This investigation does not change the project's license.

Capture requirements:

- Inject only for an active queue job. Run capture/control logic in Archivist's
  isolated world. If the chosen engine needs page-world hooks, keep them small and
  package-owned; send no localhost capability or credentials into page context.
- Wait for a bounded document readiness/settling period. Tab `complete` alone does
  not establish that a SPA, images or lazy-loaded content are ready. Capture has
  its own deadline and must work in a background tab.
- Record `requestedUrl`, actual final URL, document identity, title, content type,
  capture time, byte count, payload hash and capture warnings. Prefer document
  title with the collected link title as fallback.
- Recheck permission after navigation/redirect and abort on a changed document
  during capture. A new hostname needs a user-gesture permission request in the
  panel; do not repeatedly fail or silently grant broad access.
- Define supported frame/resource coverage. Same-origin page fetches can retain
  the page's login context. Cross-origin resources may need separately granted
  host access and an extension-side fetch adapter. Site permission for the page
  does not cover all CDNs. Report missing resources; do not claim universal
  authenticated or cross-origin-frame fidelity.
- Keep resource fetches separate from the fixed localhost API client. Any resource
  broker validates sender/job, scheme, redirects, size and permitted origin;
  block loopback/local-service destinations so a page cannot turn capture into
  arbitrary localhost requests. Add bounded concurrency and request deadlines.
- Capture failure must not fall back to raw DOM HTML or pretend a URL-only parent
  is an archive. Specify which missing optional assets produce warnings and which
  invalidate a capture before implementing the quality checks.

Native `chrome.pageCapture.saveAsMHTML()` produces MHTML, while the examined Zotero
snapshot path imports HTML. It is not a format-compatible drop-in replacement.
Supporting MHTML would require a different attachment/import and viewing design.
See [Chrome pageCapture][page-capture].

### Payload transfer and temporary storage

Do not return a large snapshot through one `executeScript` result or one runtime
message. Chrome's [message limit][chrome-messaging] is 64 MiB; JSON escaping adds
size. Use ordered chunks with acknowledgements, attempt/document identity, total
length validation, and an integrity hash. Proposed starting limits are 512 KiB
encoded messages, a 20 MiB UTF-8 snapshot, and a 120-second capture deadline;
these are product limits to validate, not Zotero limits. Account for resource
buffers, JSON copies and UTF-8 expansion when enforcing memory bounds.

Store temporary payloads under extension-origin IndexedDB, keyed by attempt ID.
Keep only metadata/references in `chrome.storage.local`. This changes the current
metadata-only persistence design and requires bounded retention, quota handling,
and cleanup after success, cancellation, expiry and startup. Do not log snapshot
HTML, cookies or authorization headers. Delete abandoned payloads promptly; retain
only a short, documented window for recoverable upload failures.

The first implementation can keep HTTP requests in the service worker with
explicit deadlines below Chrome's 30-second fetch-response limit (start with 20
seconds and measure). Capture completion/progress messages wake the worker; an
open port or a pending promise alone is not durable execution. Persist checkpoints
and resume or classify interruption conservatively. [Worker lifetime rules][chrome-lifecycle]
apply even if a panel is open.

If representative captures/uploads cannot fit those bounds, add a packaged
**offscreen upload document**, using `BLOBS` only when actually handling Blobs,
with its own receipt persistence. It requires the `offscreen` permission and
runtime messaging; it cannot call `chrome.storage` or other extension APIs directly.
It also cannot recreate the original page's authenticated live DOM. Treat this as
a measured follow-up, not a way to avoid recovery design. See [Offscreen API][chrome-offscreen].

## 7. Queue jobs, partial saves and recovery

The current provider's `{ok, error}` result and queue restart behavior are
insufficient for two non-atomic external writes. Introduce a durable attempt record
and an outcome that distinguishes safe failure, partial save, uncertain save,
interruption and confirmed completion.

Suggested attempt metadata:

```text
attemptId, queueItemId, providerMode, sessionId, generation
requestedUrl, finalUrl, tabId, documentId, title
expectedDestination, payloadRef, payloadBytes, payloadHash
phase, startedAt, updatedAt, deadlineAt
parentAcknowledged, attachmentAcknowledged, lastHttpStatus, lastError
```

Proposed phases:
`capturing -> captured -> creating_parent -> parent_created -> uploading_snapshot
-> completed`, with terminal `failed_before_write`, `partial`, `needs_review`, and
`cancelled_before_write` outcomes. Persist each write-intent phase **before sending**
and its receipt after acknowledgement. Atomically store attempt/receipt changes
within their storage domain and tolerate an interrupted update of queue metadata:
`completed` is authoritative when reconciling a still-active queue item.

| Interrupted/failed phase | Recovery rule |
| --- | --- |
| Before a write was dispatched | Safe to recapture/retry after validating permission and document; discard invalid partial chunks |
| `creating_parent`, no durable 201 receipt | `needs_review`; a parent may exist. Do not mint another session automatically |
| Parent 201 persisted, upload definitely not dispatched | Reuse the same session and payload after preflight; missing session requires review |
| Upload explicitly refused before import, e.g. 200 files-not-editable | `partial`; an explicit upload retry may reuse the session after resolving the cause |
| `uploading_snapshot`, no durable 201 receipt | `needs_review`; repeating the upload may add a second attachment |
| Attachment 201 persisted | Reconcile to `archived` and finish local cleanup without repeating any write |
| Zotero restart / `SESSION_NOT_FOUND` after parent creation | Preserve partial/uncertain result; do not create a new parent automatically |

Important protocol limitations:

- Reusing an existing session ID for `saveSnapshot` returns **409 `SESSION_EXISTS`**,
  not the original successful result. A session is registered before the save
  completes, so 409 does not prove a parent was successfully created.
- `saveSingleFile` is not idempotent for a webpage session: each successful call
  imports an attachment. A timeout, lost response, worker crash or abort cannot
  prove that no side effect occurred.
- Sessions live in Zotero's memory. Do not rely on persistence across app restart
  or a fixed retention duration, and do not invent a session-query API.
- `archived` requires validated capture plus durable acknowledgement of attachment
  import. No per-item “archived” flag should be set after parent creation alone.

Add a visible `needs_review` queue state (or equally explicit outcome field), with
text such as “Zotero may already contain this item; check before retrying.” Ordinary
“Retry Failed” must skip partial/uncertain writes unless the user explicitly chooses
a recovery action. Preserve the attempt history across retries.

The engine must re-read the **current** runtime and attempt generation before
applying any asynchronous result. Stop/remove must invalidate the active generation
and signal cancellation; a late completion must not overwrite a cancelled item or
advance a different queue run. Cancelling a request does not undo Zotero writes.
Pause should stop starting new items while allowing the current committed save
sequence to settle. Document that distinction in the UI.

A watchdog must supervise capture/save deadlines separately from page-load timeout.
Its work cannot sit behind a never-settling provider promise in the existing queue
promise chain. Use finite provider deadlines and checkpoint-driven recovery.

## 8. Permissions, trust boundaries and diagnostics

Request `http://127.0.0.1/*` through the panel's Start/Connect user gesture, separately
from queued-site permissions. The existing optional `http://*/*` declaration already
permits that request; there is no need to add broad required host access. The host
grant is broader than the intended endpoint, so the HTTP client must enforce port
23119 and its endpoint allowlist itself.

Prefer extension-context `fetch` with explicit deadlines and `redirect: "error"`.
Content scripts remain subject to page-origin network restrictions even when the
extension holds host permissions. See [Chrome network requests][chrome-network].

New capture/progress/resource messages require sender validation before routing:
check extension ID, actual `sender.tab.id`, frame/document identity and the active
attempt/generation. Content messages cannot choose arbitrary Zotero endpoints or
start new library writes. Panel controls must be accepted only from the expected
extension UI context. Currently `service-worker.js` discards `_sender`, so adding
only payload schemas to `message-router.js` is insufficient.

Replace the Connector-specific diagnostics model with local-provider fields such
as `permissionGranted`, `reachable`, `clientVersion`, `apiVersion`,
`protocolSupported`, `targetWritable`, `targetFilesWritable`, `captureReady`,
`lastError`, and `updatedAt`. Missing permission, stopped Zotero, unsupported
protocol, capture failure, partial save and uncertain save need different messages.
Do not retain red “Connector extension”/“Bridge” indicators for a provider that uses
neither. The three primary statuses can become Local access, Zotero, and Save target.

## 9. Repository changes needed for implementation

| Area | Proposed change |
| --- | --- |
| `zotero/local-client.js` (new) | Fixed-origin HTTP transport, headers, status/body parsing, version checks, timeouts and error classification |
| `zotero/provider-local.js` (new) | Health/preflight and checkpointed parent/attachment save sequence |
| `background/snapshot-capture.js`, `content/snapshot.js` (new) | Authorized capture lifecycle, pinned engine adapter, document checks, chunks and resource fetches |
| `background/save-job-repo.js` (new) | Temporary IndexedDB payloads and durable write-intent/receipt records |
| `zotero/provider-interface.js` | Structured outcomes and provider-neutral diagnostics |
| `background/provider-orchestrator.js` | Select `local_zotero`, pass attempt identity, preserve detailed results instead of collapsing them to `{ok:true}` |
| `shared/protocol.js`, `shared/state.js` | Provider mode, new message contracts, attempt/outcome fields and migrations; current normalizers discard unknown fields |
| `background/storage-repo.js` | Migrate existing queue/diagnostics and reconcile metadata with job receipts |
| `background/queue-engine.js`, `queue-lifecycle.js` | Resume by phase, cancellation generation checks, save watchdog, partial/uncertain retry behavior |
| `background/service-worker.js`, `message-router.js` | Validate senders and dispatch capture/permission/job messages |
| `sidepanel/` | Local permission gesture, diagnostics, destination label, partial/needs-review states and recovery controls |
| `manifest.json`, dependency metadata | Only changes required by the selected packaged capture engine; optional offscreen permission if validated necessary |
| `README.md`, tests | Update prerequisites and usage only when the provider actually ships; add real browser/Desktop coverage |

Migrate old active `opening_tab`/`saving_snapshot` records conservatively on upgrade.
Do not resume a stale Connector attempt as a fresh local write. Preserve pending
URLs, selectors, pacing and selection. Until migration and tests are ready, the
legacy provider remains the implemented runtime; the design does not silently
switch it.

## 10. Implementation sequence

1. **Protocol client and disposable-library smoke test.** Prove ping, target checks,
   parent creation and HTML attachment import on 10.0.6; test empty 201 bodies and
   the 200-without-file case. Use a synthetic self-contained HTML payload first.
2. **Capture proof of concept.** Select the dependency/license approach, package the
   engine, implement on-demand capture and bounded transfers. Validate actual
   offline-readable HTML, authenticated content, frames, assets and background tabs.
3. **Durable jobs and lifecycle changes.** Add checkpoints, outcomes, cancellation,
   cleanup and restart behavior before enabling writes through the normal queue.
4. **Provider/UI integration and migration.** Add local access, diagnostics and
   recovery controls; update installation documentation and run full regression tests.

Do not declare the feature complete after a successful localhost POST. Acceptance
requires a parent **and a usable snapshot**, accurate outcome reporting, and safe
behavior when any boundary is interrupted.

## 11. Alternative: Zotero 10's authenticated local API

Zotero 10.0.6 also implements `/api/`, including writes and file uploads. It is a
separate design option with explicit library paths, durable item keys and readback.
The running instance returned **403 `Local API is not enabled`**; this investigation
did not enable it or request credentials. See [local API implementation][local-api].

For an explicitly Zotero-10-only provider needing unattended recovery, evaluate
this route before committing to the Connector API's uncertain-write limitations:

1. Enable local API access in Zotero. Read `/api/` and retain the
   `Zotero-Server-ID` and API version. Browser-origin requests also need the server's
   accepted request header; validate the exact extension request path in the spike.
2. Request local authorization via `POST /api/local/authorize` with
   `{"appName":"Webpage Archivist"}` and the required server-ID header. Zotero shows
   its own consent dialog. Write requests use a local `Zotero-API-Key` and
   `Zotero-Server-ID`; these keys are unrelated to zotero.org keys. One-time access
   is consumed by a write; handle 401 without silently starting an authorization loop.
3. Persist generated valid parent/attachment keys before creation. POST item JSON to
   `/api/users/0/items` (or the chosen group path), using `version: 0` for new keyed
   items. Inspect `successful`/`failed` entries even when the batch HTTP status is
   200. Read by key to reconcile an interrupted create; never overwrite a mismatched
   existing object merely because its key exists.
4. Create an `imported_url` HTML attachment with `parentItem` referring to the parent
   key. File upload is three-phase: authorize via `POST .../items/<key>/file` with
   form-encoded MD5, filename, size, millisecond mtime and precondition headers;
   POST bytes to the returned loopback upload URL; then register the upload key
   at the attachment's `/file` endpoint. Registration returns 204. Honor existing
   file/version preconditions and verify file contents/metadata during recovery.
5. Bind receipts, credentials and object versions to the server ID. A changed
   Zotero instance must not inherit another database's save/recovery state.

This adds settings, authorization, credential handling, destination selection and
more HTTP operations. It offers stronger reconciliation than opaque Connector
sessions, but still needs durable jobs and file-upload crash tests. It shares the
same browser capture requirements. Do not combine the two protocols opportunistically
inside one attempt or silently fall back between them after a write failure.

## 12. Validation and open decisions

Completed investigation checks:

- Running Desktop ping: 200, Zotero 10.0.6, Connector API 3; POST ping preferences
  include `supportsAttachmentUpload`.
- Destination read: 200, item/file editing allowed. Names/tags were not added to
  this document or application storage.
- Empty `saveSingleFile` request: 400 `SESSION_ID_NOT_PROVIDED`, before any mutation.
- `sessionProgress`: 404. `/api/`: 403, disabled.
- Source review of parent/attachment handlers, sessions, snapshot file import,
  Connector capture/message code, local API writes, and upstream tests asserting
  parent membership and saved HTML bytes.

Required automated tests:

- HTTP contract: headers, timeouts, redirects, unexpected service/version, invalid
  JSON, empty 201, 200 files-not-editable, 409 session-exists, missing session and 5xx.
- Capture: document changes, cross-origin permissions, absent resources, deadlines,
  unsupported MIME, UTF-8/chunk boundaries, limits, malformed/duplicate chunks,
  sender mismatch and cleanup.
- Jobs: restart at every pre/post-write boundary, lost response, failed local receipt
  persistence, Zotero restart, stale generation, stop/pause/remove, late responses,
  abandoned payloads, partial outcomes and exclusion from ordinary retry.
- Migration/normalization: retain new fields, preserve existing selections/settings,
  migrate diagnostics and prevent stale bridge jobs from creating new local items.

Required integration tests use an isolated Chromium profile and disposable Zotero
profile/library, with the official browser Connector **disabled or absent**. Test
one public HTML page and one authenticated/dynamic fixture; verify the parent,
exactly one imported attachment, saved content and offline asset rendering. Include
multiple destinations, a files-read-only library, redirects, large pages, real
worker suspension and a closed side panel. Do not use someone's real library as
the retry/crash test fixture. The existing 104 passing module tests do not cover
these integration properties.

Open decisions before shipping:

- Snapshot engine revision, packaging/license approach and required browser hooks.
- Resource/frame coverage, capture-quality rules and validated size/time limits.
- Whether conservative manual review is acceptable, or the `/api/` design is needed
  for stronger recovery and explicit destinations from the first release.
- Whether measured upload duration requires an offscreen document.
- Exact supported Zotero versions; 10.0.6 is the investigated baseline, not a claim
  of compatibility with every API-3 application.

## 13. Sources and reproduction

The upstream links below are pinned to the inspected releases where possible.
The local repositories used were:

- `/home/arjan/Projects/Browser-extensions/zotero-connectors`
- `/mnt/hdd1/Cache22/github.com/zotero/zotero/zotero.git` (bare)

Reproduce source inspection without checking out or modifying Zotero:

```sh
git --git-dir=/mnt/hdd1/Cache22/github.com/zotero/zotero/zotero.git \
  show 10.0.6:chrome/content/zotero/xpcom/server/server_connector.js
git --git-dir=/mnt/hdd1/Cache22/github.com/zotero/zotero/zotero.git \
  show 10.0.6:chrome/content/zotero/xpcom/server/saveSession.js
git --git-dir=/mnt/hdd1/Cache22/github.com/zotero/zotero/zotero.git \
  show 10.0.6:chrome/content/zotero/xpcom/server/server_localAPI.js
```

[bridge-removal]: https://github.com/zotero/zotero-connectors/commit/7f618c21e4f57baebfb0dd209db33b267ef7b159
[server-connector]: https://github.com/zotero/zotero/blob/536244c2771f590abab9c09a3c27e615e0b318ff/chrome/content/zotero/xpcom/server/server_connector.js
[save-session]: https://github.com/zotero/zotero/blob/536244c2771f590abab9c09a3c27e615e0b318ff/chrome/content/zotero/xpcom/server/saveSession.js
[server]: https://github.com/zotero/zotero/blob/536244c2771f590abab9c09a3c27e615e0b318ff/chrome/content/zotero/xpcom/server/server.js
[connector-tests]: https://github.com/zotero/zotero/blob/536244c2771f590abab9c09a3c27e615e0b318ff/test/tests/server_connectorTest.js
[singlefile-adapter]: https://github.com/zotero/zotero-connectors/blob/ce29dfa360d1ce17a3a1f15a9d338d638a073106/src/common/singlefile.js
[local-api]: https://github.com/zotero/zotero/blob/536244c2771f590abab9c09a3c27e615e0b318ff/chrome/content/zotero/xpcom/server/server_localAPI.js
[http-server-docs]: https://www.zotero.org/support/dev/client_coding/connector_http_server
[singlefile-core]: https://github.com/gildas-lormeau/single-file-core
[page-capture]: https://developer.chrome.com/docs/extensions/reference/api/pageCapture
[chrome-messaging]: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
[chrome-lifecycle]: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
[chrome-offscreen]: https://developer.chrome.com/docs/extensions/reference/api/offscreen
[chrome-network]: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

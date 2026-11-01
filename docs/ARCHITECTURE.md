# Webpage Archivist architecture

## Status

Archivist now uses Zotero Desktop's authenticated **local API**, directly at
`http://127.0.0.1:23119/api/`. It captures the loaded browser document itself and
imports a webpage plus an HTML snapshot. The official browser Connector is not
required. The old iframe bridge and its compatibility code have been removed;
there is no migration path for its provider state.

The initial protocol investigation used Zotero 10.0.6. Real integration testing
used Zotero 10.0.7 and Chromium 156, with separate browser and Zotero profiles.
[The investigation](LOCAL_PROVIDER_RESEARCH.md) records the upstream source
references and the rejected Connector HTTP approach. In particular, the browser
Connector removed the private iframe transport Archivist previously depended on.

## Modules and build

| Surface | Files | Responsibility |
| --- | --- | --- |
| Service worker | `background/service-worker.js`, `message-router.js` | Browser events, panel-only command authorization, collection and queue dispatch |
| Queue | `background/queue-engine.js`, `queue-lifecycle.js` | One active item/tab, pacing, cancellation, restart handling and outcome application |
| Queue state | `background/storage-repo.js`, `shared/state.js`, `shared/protocol.js` | Normalized queue/settings/diagnostics in `chrome.storage.local` |
| Local client | `zotero/local-client.js` | Fixed-origin requests, API identity, deadlines, authorization, library/collection enumeration |
| Connection settings | `zotero/local-settings.js` | Server-bound authorization and explicit destination |
| Provider | `zotero/provider-local.js`, `background/provider-orchestrator.js` | Keyed item creation/reconciliation, three-phase upload, health diagnostics |
| Capture | `content/snapshot.js`, `background/snapshot-capture.js` | SingleFile adapter, document binding, bounded chunk transfer |
| Save records | `background/save-job-repo.js` | IndexedDB job metadata, temporary snapshot bytes and completion receipts |
| Panel | `sidepanel/`, particularly `zotero-controller.js` | Link selection, queue controls, Connect Zotero, explicit destination and recovery feedback |
| Build | `scripts/build.mjs` | Pin and bundle SingleFile/SparkMD5; include source and license notices |

Run `npm ci && npm run build` before loading the repository unpacked. Generated
`content/snapshot.bundle.js` and `vendor/` are ignored by Git. `npm test` rebuilds
them before the Node tests. Runtime modules otherwise remain native ES modules.
There are no remotely loaded scripts. See [dependency notices](../THIRD_PARTY_NOTICES.md)
for the AGPL SingleFile dependency; Archivist's original source retains its MIT license.

## Connection and destination

The panel's **Connect Zotero** click requests optional `http://127.0.0.1/*` access.
The existing optional HTTP(S) host declarations cover it; no broad required host
permission, always-on content script, offscreen permission or cloud key is added.
The minimum Chromium version is now 120.

1. `GET /api/` returns API/version/server identity headers. API version 3 is required.
2. The panel calls `POST /api/local/authorize` with `appName: "Webpage Archivist"`
   and the server ID. Zotero presents its consent dialog. This request runs in the
   panel, with a 120-second deadline, so a worker's fetch-response lifetime does not
   cut off the user interaction. Closing the panel interrupts setup; Connect can be
   tried again.
3. The user must choose **Always Allow**. One-time keys are rejected locally because
   the save takes multiple write requests. Authorization is not requested automatically
   by queue jobs, and a 401 clears the saved key and asks the user to reconnect.
4. The local key and server ID are stored in `chrome.storage.local`, restricted to
   `TRUSTED_CONTEXTS`. They are not returned in panel-state messages, capture data,
   URLs or logs. Content scripts cannot access this storage.
5. The panel enumerates `/users/0/groups` and library collections. The destination
   defaults to **My Library** upon first connection and can be changed explicitly.
   It is bound to the server ID and pinned into each durable save job. A group API
   path uses its group ID; collection/item identifiers are eight-character keys.

Diagnostics distinguish host access, reachable API, stored authorization and
available destination. Read requests cannot validate whether a stored key has been
revoked or a group permits writes; those checks happen when Zotero handles the
write. A destination read is therefore not a promise of file editability.

The HTTP client sends `X-Zotero-Connector-API-Version: 3` to satisfy the desktop
server's browser-request check, alongside `Zotero-API-Version: 3`. Writes also use
`Zotero-Server-ID` and `Zotero-API-Key`. Every response is checked for server/API
identity. The client restricts the origin, port, paths and methods, refuses
redirects, never follows the local `/file` route's `file://` redirects, and applies
20-second request deadlines. An upload URL must exactly match the fixed local
origin and the returned upload token; upload bytes do not carry the API key.

## Capturing a page

The queue opens one background tab and waits for loading to complete. Capture
rechecks HTTP(S) access for the final URL, then injects packaged SingleFile hooks in
the main world and the capture adapter in Archivist's isolated world. Subsequent
operations are addressed to the exact top-frame `documentId`. A changed URL,
replaced document, unsupported content type, timeout or malformed transfer fails
before library creation.

SingleFile snapshots the **live DOM**, including authenticated/dynamic content.
The adapter waits for bounded deferred loading, removes scripts, inlines accessible
resources and emits HTML with a restrictive CSP. Resource requests stay in the
page's network context: same-origin requests may use its session, cross-origin
requests omit credentials and remain subject to CORS. There is no extension-side
resource fetch proxy and no path from page scripts to the localhost API client.

Initial limits and coverage:

- 120-second capture deadline; 20 MiB maximum UTF-8 snapshot.
- 15-second resource deadlines, 5 MiB per resource and 40 MiB aggregate fetched bytes.
- Embedded frames and audio/video are omitted. Missing resource requests produce
  visible queue warnings; this implementation does not promise complete rendering
  for arbitrary cross-origin frames, CDNs, protected media or all lazy-loading sites.
- PDF/EPUB imports, translator metadata, MHTML and silent URL-only fallback are excluded.
- Redirects to an ungranted host retain the final URL as a permission requirement.
  Retry followed by Start/Resume requests that origin through a panel gesture.

The worker polls the isolated capture object, then pulls ordered chunks of at most
16,000 UTF-16 code units using `executeScript`. No snapshot is returned as one large
runtime message. Chunks are joined before UTF-8 encoding, preserving surrogate pairs
at boundaries; document, total length and final byte limits are checked. The
snapshot is persisted and hashed before any Zotero write. Polls are bounded and
provide worker activity during capture; durable records handle later restarts.

## Save protocol and durable recovery

IndexedDB contains `jobs` and `payloads` object stores. A job records its queue ID,
server/library/collection, parent and attachment keys, captured final URL/title,
creation time, capture warnings, byte count, MD5, phase and acknowledged item writes.
Payload plus initial job are committed in one transaction before creating library
items. MD5 is required by Zotero's upload protocol, not used as an authentication
mechanism.

```mermaid
sequenceDiagram
  participant Q as Queue / local provider
  participant B as Browser document
  participant D as Extension IndexedDB
  participant Z as Zotero local API
  Q->>Z: Check server and destination
  Q->>B: Capture live HTML and pull bounded chunks
  Q->>D: Persist snapshot, destination, random item keys and hash
  Q->>Z: GET parent by key; POST keyed webpage if absent
  Q->>D: Record parent acknowledgement
  Q->>Z: GET attachment by key; POST imported_url attachment if absent
  Q->>D: Record attachment acknowledgement
  Q->>Z: Authorize file upload with MD5 and If-None-Match: *
  Q->>Z: Upload raw UTF-8 bytes to returned loopback URL
  Q->>Z: Register upload token with If-None-Match: *
  Z-->>Q: 204 registered
  Q->>Z: Read attachment metadata and verify MD5
  Q->>D: Persist completion and delete payload atomically
  Q->>Q: Mark queue item archived
```

Creation uses `version: 0` with keys generated and persisted by Archivist. Reads by
key precede creates. Batch HTTP 200 alone is insufficient: the provider checks
per-object failure entries and reads the keyed object back. Existing items must
match their expected identity/URL/type/parent/collection before being reused; user
changes or acknowledged items later deleted cause `needs_review`. The provider
never overwrites conflicting objects or silently chooses replacement keys.

Uploads have authorization, byte transfer and registration phases. The file
precondition prevents overwriting an existing file. If the attachment already
reports the expected MD5 after a lost response, the provider can finish without
reuploading. A different MD5 requires review. Expired upload tokens are harmless to
item identity: a retry obtains a new token for the same attachment. A completed
local receipt is authoritative if the worker stopped before updating the queue.

| Situation | Outcome |
| --- | --- |
| Capture failure or API unavailable | Failed; retry after fixing the cause |
| Lost create/upload/register response | Failed; retry reads the same keys and reconciles before further writes |
| Worker restarts with an active save | Queue resumes; persisted job avoids new keys/capture |
| Destination changed in panel | Existing jobs retain their original target |
| Wrong server, changed/deleted item, conflicting file | Needs review; excluded from ordinary retry |
| Retained payload missing/expired before completion | Needs review; no replacement parent is created |
| Durable completion receipt exists | Mark archived without another write |

This is recovery through keyed objects and conditional writes, not a multi-request
transaction. A parent or empty attachment can remain after a failure. A crash inside
Zotero's own filesystem/database commit can still need manual review. The extension
does not delete or roll back library objects to hide a partial result. Metadata MD5
is the API receipt used by the provider; the integration test additionally reads and
renders the actual files from the disposable library.

Payload retention is bounded to 128 MiB total and 24 hours. Successful jobs delete
the payload immediately; receipts remain while the queue entry exists. Cleanup on
initialization and queue removal expires payloads and deletes orphan records.
Capture and payload reads also enforce retention before accepting or reusing bytes.
The quota is a cap, not automatic eviction of another pending job. Clearing the
extension's data destroys its reconciliation keys. Do not do that to retry a save.

## Queue lifecycle and trust boundaries

Queue item states are `pending`, `opening_tab`, `saving_snapshot`, `archived`,
`failed`, `cancelled`, and `needs_review`; runtime states are idle/running/paused.
The provider's warnings and review outcomes survive orchestration and normalization.

Pause prevents new work and lets an executing save settle. Stop/remove/clear
invalidate the engine generation and abort active requests. The provider checks
cancellation before writes; the engine checks the current generation, active item,
tab and status before applying any result. A late completion cannot advance another
run or turn a stopped item into archived. Abort does not undo remote side effects;
Retry / Reconcile uses the durable job. Review outcomes are not included in bulk retry.

A four-minute save deadline bounds the provider wait independently of the page-load
timeout. The watchdog can signal cancellation without waiting behind the provider
promise. Pacing uses both a short timer and an alarm, and the worker recovers queue
state on activation as well as browser startup.

Only messages from the exact Archivist panel URL and extension ID reach privileged
command routing. A page content script cannot invoke Start, authorize, choose an API
path, or fetch through the extension. Capture is pulled by the worker from a fixed
document rather than accepting page-supplied progress messages.

## Verification and remaining limits

`npm test` covers API headers, server binding, rejected endpoints/redirect policy,
empty responses, per-object errors, lost write responses, cancellation, conflicting
items, expired payloads, chunk/document validation, and queue/panel/storage behavior.
The prior iframe tests were replaced with local-provider tests.

`tests/integration/local-zotero.mjs` uses a separate Chromium profile and disposable
Zotero profile, with no browser Connector. It archives a public and cookie-protected
fixture, checks the resulting HTML files for live DOM/Unicode content and embedded
assets, and renders both offline to verify text, CSS and images. A test-only copy
points at port 23129; production remains fixed at 23119. The test uses a preseeded
key belonging only to that disposable profile; interactive consent remains the
user's Connect step in normal installation.

Group write restrictions, complex frames/media and hard process termination during
Zotero file registration need broader integration coverage. An offscreen upload
context is not currently used; large or slow local requests fail at the explicit
deadline and can be reconciled on retry. No compatibility fallback to the Connector
or the cloud API is provided.

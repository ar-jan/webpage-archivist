# Webpage Archivist

A Chromium extension that collects links and archives selected pages directly to
Zotero Desktop as webpage items with HTML snapshots. The browser Zotero Connector
is not required.

## Install and connect

1. Use Zotero 10 with its local API enabled. The implementation was investigated
   against 10.0.6 and tested end to end against 10.0.7.
2. Install Node.js 24+, clone this repository, and run:

   ```sh
   npm ci
   npm run build
   ```

3. Open Chromium's `chrome://extensions`, enable **Developer mode**, and **Load
   unpacked** from this repository. After updating source/builds, click **Reload**
   on the extension. Chromium 120+ is required.
4. Open Archivist's side panel, click **Connect Zotero**, grant local access, and
   choose **Always Allow** in Zotero's authorization dialog. Keep the panel open
   until the connection finishes. One-time authorization cannot complete a save,
   because a snapshot requires several writes.
5. Choose a library or collection in **Save to**. New items use that destination;
   retries retain the destination selected when the save began.

## Archive pages

Collect links from an HTTP(S) page, grant access when prompted, select links and
add them to the queue. **Start** requests access to queued sites and processes one
page at a time. Logged-in page content is captured in your browser.

**Pause** stops starting new items while the current save settles. **Stop** cancels
work but cannot undo writes already made to Zotero. **Retry / Reconcile** resumes
failed or stopped jobs using their original item keys, avoiding replacement items
when a response was lost. Items marked **needs review** require checking Zotero;
they are excluded from ordinary retry. Clearing/removing a queue entry removes its
local recovery record, not its Zotero items.

The initial capture implementation supports HTML pages up to 20 MiB, with a
120-second capture deadline. It embeds accessible assets and removes scripts.
Embedded frames, video/audio, and resources blocked by page-origin restrictions
are not preserved; missing-resource warnings appear on the queue item. PDF/EPUB
imports and metadata translators are not supported. A redirect to a new hostname
records an extra permission requirement; use Retry / Reconcile, then Start to
grant it.

Snapshot payloads are stored temporarily in extension IndexedDB (128 MiB total,
24-hour retention) and deleted after successful import. Do not clear the extension's
data to recover an interrupted save: that also deletes the keys used to reconcile
it. Local API authorization stays in trusted extension storage and is never sent
to captured pages or zotero.org.

## Development and verification

```sh
npm test                    # builds dependencies and runs module tests
npm run test:watch
```

The opt-in real-browser test uses a **disposable** Zotero profile with its own data
directory, local API on port 23129, and a test-only authorization key. It refuses
profiles outside `/tmp/archivist-zotero-test-*`. With that profile running:

```sh
ARCHIVIST_TEST_ZOTERO_PROFILE=/tmp/archivist-zotero-test-EXAMPLE/profile \
  node tests/integration/local-zotero.mjs
```

This creates a separate Chromium profile, builds a test copy targeting the
isolated API port, archives public/authenticated fixtures, and checks offline HTML,
CSS and image rendering. It leaves its temporary artifacts for inspection.

See [architecture](docs/ARCHITECTURE.md) and [dependency notices](THIRD_PARTY_NOTICES.md).

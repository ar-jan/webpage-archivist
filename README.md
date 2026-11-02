# Webpage Archivist

A Chromium extension that collects links and archives selected pages directly to
Zotero Desktop as webpage items with HTML snapshots. The browser Zotero Connector
is not required.

## Install and connect

1. Use Zotero 10 with its local API enabled. The implementation was investigated
   against 10.0.6 and tested end to end against 10.0.7.
2. Clone this repository. Node.js, npm, and a build are **not required** to install
   or update the extension: the browser-ready dependencies are checked in.
3. Open Chromium's `chrome://extensions`, enable **Developer mode**, and **Load
   unpacked** and select the **repository root** (the directory containing
   `manifest.json`). Chromium 120+ is required.
4. Open Archivist's side panel, click **Connect Zotero**, grant local access, and
   choose **Always Allow** in Zotero's authorization dialog. Keep the panel open
   until the connection finishes. One-time authorization cannot complete a save,
   because a snapshot requires several writes.
5. Choose a library or collection in **Save to**. New items use that destination;
   retries retain the destination selected when the save began.

To update, run `git pull` in the same checkout, then click **Reload** for Archivist
in `chrome://extensions`. There is no install/build command between those steps.
Keep the checkout at the same path so the unpacked extension retains its identity
and stored settings. Keep generated files unmodified so pulls can update them.

If you previously loaded `dist/`, switch once to loading the repository root.
This changes the unpacked extension identity: configure its rules and connect to
Zotero again. No old extension state is migrated. The old `dist/` installation no
longer receives updates; disable or remove it after switching.

## Archive pages

Collect links from an HTTP(S) page, grant access when prompted, select links and
add them to the queue. After editing selector rules, use **Save rules** or click
**Collect Links** to save them automatically before collection. Invalid rules or
a failed save keep the draft editable and stop collection. Rule saves write
directly to extension storage without a service-worker round trip. If storage
does not respond within five seconds, Save becomes available again and the draft
is retained for retry.

Link collection runs directly from the panel and does not need Zotero to respond.
It scrolls by default to find links loaded later. If reading the page stalls,
Collect becomes available again with a timeout message; the previous links remain.
Keep the panel open until collection finishes. Queue saves run in the background
and continue after the panel closes.

**Start** requests access to queued sites and processes one
page at a time. Logged-in page content is captured in your browser.

**Pause** stops starting new items while the current save settles. **Stop** cancels
work but cannot undo writes already made to Zotero. **Retry / Reconcile** resumes
failed or stopped jobs using their original item keys, avoiding replacement items
when a response was lost. Items marked **needs review** require checking Zotero;
they are excluded from ordinary retry. Clearing/removing a queue entry removes its
local recovery record, not its Zotero items.
Cleanup waits for outstanding save operations to settle after cancellation.
If a queue command times out, inspect the queue status before retrying: a timeout
does not cancel a command that the worker already received.

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

Contributors need Node.js 24+ and `npm ci`. Normal application modules run directly
from the checkout. After changing `content/snapshot.js`, the build script, or the
pinned dependencies, run `npm run build` and commit the resulting `vendor/` and
`content/snapshot.bundle.js*` changes together with the source/lockfile changes.
`vendor/` is generated; do not edit its files by hand.

```sh
npm ci
npm run build               # regenerate committed assets only when their inputs change
npm run check:assets        # compare against a fresh build without changing the checkout
npm test                    # check assets, test modules and clean-source reproducibility
npm run test:watch
node tests/integration/selector-rules.mjs  # isolated Chromium selector/collection test
node tests/integration/worker-startup.mjs  # checkout startup/reload, capture and checksum
node tests/integration/panel-startup.mjs  # delayed initialization and offline readiness
```

CI checks the committed assets before testing, without rebuilding them in place,
so missing or stale bundles fail instead of being silently repaired. It also tests
Chromium startup, reload with retained storage, and snapshot capture from a copy
of the checkout without `node_modules` or `dist`.

The opt-in real-browser test uses a **disposable** Zotero profile with its own data
directory, local API on port 23129, and a test-only authorization key. It refuses
profiles outside `/tmp/archivist-zotero-test-*`. With that profile running:

```sh
ARCHIVIST_TEST_ZOTERO_PROFILE=/tmp/archivist-zotero-test-EXAMPLE/profile \
  node tests/integration/local-zotero.mjs
```

These browser tests load a copy of the repository's runtime files, with no build
step. Set
`ARCHIVIST_TEST_CHROMIUM=/usr/bin/brave-browser` to exercise Brave.

The Zotero test creates a separate browser profile and a test copy targeting the
isolated API port, archives public/authenticated fixtures, and checks offline HTML,
CSS and image rendering. It leaves its temporary artifacts for inspection.

See [architecture](docs/ARCHITECTURE.md) and [dependency notices](THIRD_PARTY_NOTICES.md).

# Repository Guidelines

## Project Structure & Module Organization
- `manifest.json`: MV3 extension entrypoint and permission model.
- `background/`: service-worker runtime (`message-router`, queue engine/lifecycle, provider orchestration).
- `sidepanel/`: panel UI (`panel.html/css/js`) plus focused controllers and store/render modules.
- `content/collector.js`: on-demand page link collection logic.
- `shared/`: cross-surface contracts, storage repository, state normalization and timeout utilities.
- `zotero/`: authenticated local Zotero API client, settings, and provider.
- `tests/`: module-level `node:test` suites and `tests/test-helpers/` mocks.
- `docs/`: architecture and design notes for extension behavior and constraints.

## Build, Test, and Development Commands
- `npm install`: install local Node dependencies.
- `npm test`: check committed runtime assets, then run all tests (`node --test tests/*.mjs`).
- `npm run test:watch`: rerun tests on file changes.
- `npm run build`: regenerate committed snapshot/checksum bundles and upstream source/notices after changing their inputs; commit those outputs with the source changes.
- `npm run check:assets`: verify committed assets against a temporary fresh build without modifying the checkout.
- For manual validation, load the repository root in Chromium via `chrome://extensions` -> **Developer mode** -> **Load unpacked**. Installation needs no npm/build step; updates are `git pull` then **Reload**, using the same checkout path.
- `vendor/` and `content/snapshot.bundle.js*` are generated and tracked. Do not edit them by hand or rebuild them automatically before freshness checks.
- `third-party/` holds pinned source archives, imported license texts and provenance. Dependency upgrades must review/update these inputs and the component inventory before regenerating assets.
- The combined extension is AGPL-3.0-or-later; original Archivist source also has a separate MIT grant. Preserve both scopes and the panel's local license/source access.

## Coding Style & Naming Conventions
- Language/runtime: modern JavaScript ES modules (`import`/`export`), MV3 service worker.
- Formatting: 2-space indentation, semicolons, double quotes, trailing commas where already used.
- Naming: files in kebab-case (for example, `queue-engine.js`); functions/variables in camelCase; exported constants in UPPER_SNAKE_CASE.
- Keep shared contracts in `shared/protocol.js` and shared normalization/state helpers in `shared/state.js`.
- No eslint/prettier config is committed; match surrounding style and keep modules narrowly focused.

## Testing Guidelines
- Framework: Node built-in `node:test` with `node:assert/strict`.
- Test files: `tests/*.test.mjs` (one module/feature area per file).
- Prefer deterministic mocks from `tests/test-helpers/` for Chrome/Zotero API behaviors.
- When changing queue, routing, or provider code, add/adjust tests for state transitions, message contracts, and failure paths.
- Run `npm test` before opening a PR.

## Commit & Pull Request Guidelines
- Commit subjects in recent history are short, imperative, and sometimes scoped (`Maintenance: ...`, `Refactor: ...`).
- Example style: `Maintenance: add storage-repo coverage`.
- PRs should include: concise summary, rationale, test evidence (`npm test`), and screenshots for `sidepanel/` UI changes.
- Link related issue/task when available and highlight any permission or `manifest.json` changes explicitly.

## Security & Configuration Tips
- Preserve least-privilege permissions; prefer runtime host permission requests over broad defaults.
- Avoid always-on content script injection unless explicitly required.
- Keep implementation scope aligned with `docs/ARCHITECTURE.md` and active user issues/feature requests.

# Repository cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Find and remove unused code and unnecessary duplication throughout the repository, with reference evidence and regression verification.

**Architecture:** Audit first-party runtime code, tests, scripts, dependencies and deployment entry points. Remove superseded implementations and keep active HTTP, storage, migration, identity and editor contracts.

**Tech Stack:** FastAPI, SQLite, native browser ES modules, CodeMirror, pytest and offline Chromium tests.

**Spec:** User instruction to identify and clean useless/redundant code; repository `AGENTS.md`.

## Global constraints

- Preserve account isolation, CSRF, paid-provider quota/accounting, cancellation and old storage replay/migration contracts.
- No live provider calls, production database changes or secret inspection.
- Do not infer that framework callbacks, generated CSS names or test inspection helpers are dead.
- Use existing regression suites for deletions; add tests only if a behavior change needs additional coverage.
- Work in the current clean checkout on a separate cleanup branch; leave changes reviewable without publishing.

## Review focus

- Authentication dependencies must still execute after import/alias cleanup.
- First explanation and follow-up usage must remain atomic with saved messages.
- Database initialization must still cover each fresh test database.
- Session switches must invalidate pending AI work and render the correct empty state.
- Markdown safety and original source ranges must be tested through the production block renderer.

## Task 1: Backend and dependency leftovers

- [x] Remove uncalled `require_client_id`, unused `admin_account` route import, unused engine `VoiceInfo` re-export and history `datetime` import.
- [x] Replace `_resolve_client_ip` consumers/tests with `resolve_client_ip`, then remove its alias.
- [x] Remove explanation-only `_initialized`, `_init_lock`, `threading` and obsolete test resets; shared database initialization stays active.
- [x] Remove uncalled `record_usage` and its export; preserve transactional `_upsert_daily_usage` callers.
- [x] Remove unreferenced `requirements.txt`; `pyproject.toml` and `uv.lock` are the actual setup/CI/Docker inputs.
- [x] Remove the unconnected `prune_tombstones` implementation and its sole test; correct misleading periodic-cleanup documentation.
- [x] Drop redundant history/explanation indexes after checking actual query plans, with an old-database/repeated-startup regression.
- [x] Run the full backend suite: `& '.\.venv\Scripts\python.exe' -m pytest tests -q` (baseline: 470 passed).

## Task 2: Frontend duplication and obsolete interfaces

- [x] Consolidate minute/second conversation date formatting in `frontend/app.js` with unchanged displayed formats.
- [x] Remove the extra AI reset before `setCurrentExplainText`, which already invalidates the previous session.
- [x] Remove test-only `renderArticleMarkdown`; migrate `scripts/test_article_markdown.cjs` to the actual `renderArticleBlocks` output.
- [x] Remove confirmed unused `.ai-heading` CSS while preserving related active classes and dynamic resizer/editor selectors.
- [x] Remove four unused CSS token names (eight declarations).
- [x] Extract eight repeated static-file responders into one shared offline test helper; retain fixture-specific API behavior and verify HTTP asset/path boundaries.
- [x] Verify every frontend suite, including standalone sidebar/popover/send regressions.

## Task 3: Whole-repository completion audit

- [x] Recheck remaining definitions, imports, state, CSS, dependencies, CLI, CI and deployment consumers.
- [x] Independently verify Antigravity's findings; record false positives and active compatibility boundaries.
- [x] Review the full diff, run `git diff --check`, rebuild the editor and confirm vendor artifacts are unchanged.
- [x] Record exact cleanup evidence, verification results and remaining limitations in a cleanup report.

## Execution record

- Initial state: clean checkout at `e715417`, branch `feat/verify-and-resolve-pending-findings`.
- Baseline: 470 backend tests passed, two third-party deprecation warnings.
- Implementation branch: `refactor/remove-unused-code`.
- Final evidence and decisions: `docs/repository_cleanup_2026-10-07.md`.

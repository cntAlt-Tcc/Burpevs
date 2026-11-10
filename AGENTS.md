# AGENTS.md

## Workflow preferences

- **Always open a PR when work is done.** After finishing a task that changes
  files, commit on a feature branch, push, and open a pull request against
  `main` — do not wait to be asked. (Explicit user instruction.)

## Repository

- Single-file Tampermonkey/Greasemonkey userscript: `user.js` (BurpImpure v7).
- XHR/Fetch interceptor with a Burp-Suite-style UI.
- No build step, no tests infrastructure in-repo. Validate changes with
  `node --check user.js` and, for the injected page-world hook, runtime tests
  against mocked browser globals.

## Architecture notes

- Two worlds: Tampermonkey sandbox (UI/state) and page world (the hook injected
  via an inline `<script>`), bridged with `postMessage` using `BRIDGE` and
  `ORIGIN`.
- Response rules are applied in the page world before the body is returned to
  the site.
- The userscript runs in **all frames** (`@allFrames true`). Only the top frame
  builds the UI (`IS_TOP`); subframes keep the hook, apply rules, and forward
  captured requests to the top frame via `postMessage` (with a `fwd` flag to
  avoid loops).
- `user.js` is **idempotent**: a guard (`window.__BIP7_LOADED__` plus a
  `documentElement.dataset.bip7` marker) makes a second execution on the same
  page a no-op, so the UI/interceptor are never duplicated.
- Request history (`S.reqs`) is **persisted** in `GM` storage under `HK`
  (`bip_hist_v7`), capped at `PERSIST_MAX` items with bodies truncated to
  `PERSIST_BODY` chars. It is restored by `loadHistory()` at boot, so the list
  survives reloads **and** navigating to another site (Tampermonkey storage is
  per-script, shared across all matched domains).
  - Persistence is **top-frame only** (`IS_TOP`) to avoid write races between
    frames, and it is **synchronous** (`persistHistoryNow`).
  - `saveHistory()` debounces (400ms) but writes **immediately** when the tab is
    hidden (`document.visibilityState === 'hidden'`), because background tabs
    throttle/drop timers.
  - `flushHistory()` is wired to `pagehide`, `beforeunload` and
    `visibilitychange` in `boot()`, so leaving the page / closing the browser
    never loses the last captures.
  - An **empty** list never overwrites the stored history; only an explicit
    Clear (`persistHistoryNow(true)`) writes an empty list.

## Interception (segurar → editar → soltar)

- The **Intercept** tab has two distinct mechanisms:
  1. **Segurar tudo** (hold): with the master toggle on, **every** request is
     paused — before being sent (`request` phase) or before being returned to
     the page (`response` phase). Two sub-toggles, `S.icpHoldReq` /
     `S.icpHoldRes` (persisted under `ICK + '_holdreq'` / `'_holdres'`), pick
     which phase is held. Each held item lands in the queue where the user can
     **Soltar** (forward), **Bloquear** (drop) or **Editar** it.
  2. **Bloqueio automático** (rules): `S.icp` (persisted under `ICK` =
     `bip_icp_v7`) is a list of `{ url, method, phase, enabled }` that **block
     automatically** (never send/receive), no user decision. `url` is a
     substring match (empty = all), `method` is `ANY`/`GET`/..., `phase` is
     `request`/`response`. Rules have **no `action`** field anymore; legacy
     rules with `action:'hold'` are dropped by `loadIcp()` on migration.
- The Intercept tab has **Send/Get sub-tabs** filtering the queue by method
  (`S.heldView`): Send = non-GET, Get = GET. Each has a live count. Buttons:
  **Fluir tudo** (whole queue), **Fluir esta aba** (visible sub-tab only).
- **Editing**: the queue's *Editar* opens `#ov-icp` (`openIcpEditor`). For a
  request it exposes method/URL/headers(JSON)/body; for a response, the body.
  *Soltar (deixar ir)* sends the edits back with the decision.
- Enforcement lives in the **page world** hook. `matchBlock(url, method, phase)`
  returns the matching block rule; `shouldHold(phase)` decides whether to pause
  everything. Only the **top frame** enforces interception (`IS_TOP`).
- Decision protocol: the hook posts `{held:true, phase, id, ...}` and awaits a
  decision; the UI replies `{__BIP_DECISION__, id, drop, req?, resBody?}`.
  Pending decisions are tracked in a `Map` (`waitDecision`).
  - fetch request: awaits before sending; `req` edits are re-applied on a
    rebuilt call (original `init` is preserved when there is no edit); Drop
    rejects with `TypeError('Failed to fetch')`.
  - fetch response: awaits before returning; `resBody` returns an edited
    `Response`; Drop returns an empty `Response`.
  - XHR request: `send` is deferred until Forward; `req` edits are re-applied
    (headers via `setRequestHeader`, body via `args[0]`, URL/method via a fresh
    `open`); Drop calls `abort()`.
  - XHR response: the `load` emit is deferred until the decision; `resBody`
    is reflected in the emitted capture; Drop aborts.
- Held items are shown in the queue (`renderHeld`); `S.icpEdit` tracks the item
  open in the editor. Turning the master off forwards everything still held so
  the site never stays stuck.

## UI stacking (painel por baixo do site)

- The UI is appended to `document.documentElement` (not `body`) so it survives
  sites that swap/re-render the whole `<body>`.
- `#bip`, `#bip-orb` and the modals use `z-index:2147483647!important` /
  `...648!important`.
- `watchUI()` runs a `MutationObserver` + a 1.5s interval: if the UI is
  removed it is re-appended (`reattachUI`), and `ensureTop()` bumps the panel's
  `z-index` above any site overlay that paints higher.

## Loader (`loader.user.js`)

- Runs the remote `user.js` in its **own** userscript scope. Consequences:
  - The loader header must `@grant` **every** `GM_*` API that `user.js` uses
    (currently `GM_addStyle`, `GM_setClipboard`, `GM_getValue`, `GM_setValue`,
    plus a superset for future-proofing). Missing grants show up as
    `ReferenceError: GM_addStyle is not defined` inside the `user.js`.
  - Tampermonkey exposes granted `GM_*` as **lexical bindings in the userscript
    scope, not as globals on `window`**. So the remote code must be run with
    **direct `eval(code)`**, never indirect `(0, eval)(code)` — the indirect
    form evaluates in the global scope and the `GM_*` names are undefined
    there. This was the root cause of a loader bug (PR #3 fixed the grants,
    PR #4 fixed the eval form).
  - Validate with a test that runs the real `user.js` in a scope exposing
    `GM_*` only as function parameters (mirrors the TM sandbox): indirect eval
    reproduces the error, direct eval runs clean.

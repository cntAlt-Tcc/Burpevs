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

## Interception (segurar / bloquear)

- New **Intercept** tab: rules that *hold* (pause until the user picks
  Forward/Drop) or *block* (never send/receive) requests and responses.
- Rule shape (`S.icp`, persisted under `ICK` = `bip_icp_v7`): `{ url, method,
  phase, action, enabled }`. `url` is a substring match (empty = all),
  `method` is `ANY`/`GET`/..., `phase` is `request`/`response`, `action` is
  `hold`/`drop`. A master on/off flag is stored under `ICK + '_on'`.
- Enforcement lives in the **page world** hook: `matchIcp(url, method, phase)`
  is checked in the patched `fetch` and `XHR.send`. Only the **top frame**
  enforces interception (`IS_TOP`) to avoid duplicate decisions; subframes only
  capture.
- Hold protocol: the hook posts `{held:true, phase, id, ...}` and awaits a
  decision; the UI replies with `{__BIP_DECISION__, id, drop}`. Pending
  decisions are tracked in a `Map` in the hook (`waitDecision`).
  - fetch request: awaits before calling the original `fetch`; on Drop it
    rejects with `TypeError('Failed to fetch')`.
  - fetch response: awaits before returning; on Drop it returns an empty
    `Response` (body hidden). Forward falls through to the normal
    rule-patching path.
  - XHR request: `send` is deferred until Forward; Drop calls `abort()`.
  - XHR response: the `load`/`error` emit is deferred until the decision.
- The held item is shown in the Intercept tab's queue (`renderHeld`); the body
  is **viewable while held** via the detail overlay, satisfying "ver o conteúdo
  mesmo assim".

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

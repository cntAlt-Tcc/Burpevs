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
  `PERSIST_BODY` chars, and debounced via `saveHistory()`. It is restored by
  `loadHistory()` at boot, so the list survives page reloads.

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

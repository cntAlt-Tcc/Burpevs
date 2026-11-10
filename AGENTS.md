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
- The Intercept tab has **Send/Get sub-tabs** filtering the queue by **phase**
  (`S.heldView`): Send = requests (`request` phase), Get = responses
  (`response` phase). Each has a live count. Buttons: **Fluir tudo** (whole
  queue), **Fluir esta aba** (visible sub-tab only).
- **One click per transaction** (`__autoFwd`): releasing a request also
  forwards its matching response, so flowing an item (or *Fluir tudo*) does not
  require a second click to release the response that comes back. The hook adds
  the id to `__autoFwd` when a non-drop decision arrives and skips `shouldHold`
  for it. This is why the XHR response-hold decision is evaluated at `load`
  time, not at `send` time.
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
- **Pointer events**: sites often set `pointer-events:none` on `<html>`/`<body>`
  (while loading, or with a modal/cookie banner open). Because the panel is a
  child of `<html>`, it *inherited* that value, so real clicks hit-tested
  "through" the UI — the panel rendered but every click was dead. `#bip`,
  `#bip-orb`, `#rule-modal-bg` and `#icp-modal-bg` therefore set
  `pointer-events:auto!important` to stay clickable regardless of the host page.
  (A programmatic `.click()` bypasses hit-testing, so it does **not** reproduce
  this — validate pointer-events fixes with a real click / `elementFromPoint`.)

## Event delegation (sites that swallow clicks in the capture phase)

- Anti-adblock / "shortlink" / devtools-detection scripts commonly register a
  `click` listener on `document` in the **capture phase** and call
  `stopPropagation()`. That halts the event before it reaches our bubble-phase
  element listeners, so the panel renders but **no click works** (looked like
  "can't edit on certain sites" — the `Editar` button never opened the editor).
- Fix: all UI interaction handlers go through `bipOn(el, type, fn)`, which
  records them in a `WeakMap` (`__bipH`). A **single** `window` listener per
  event type (`bipDispatch`, registered with `{capture:true}`) fires **before**
  any `document` capture listener (window precedes document in the capture
  chain) and replays the event to the recorded handlers via `composedPath()`.
  Handlers still run in bubble order (target → root); `stopPropagation` inside
  a handler is honored via `e.cancelBubble`.
- Window-level drag listeners (`pointermove`/`pointerup` for panel/orb) are also
  registered `{capture:true}` for the same reason.
- Reproduce with a `click` listener on `document` that calls `stopPropagation()`
  in the **capture** phase; a plain bubble-phase listener does **not** reproduce
  it. `element.click()` and real clicks both go through capture, so both are
  blocked — this is unlike the pointer-events bug above, where only a real click
  reproduces it.
- Keep the delegation list (`BIP_EVTYPES`) to discrete events; do **not** add
  high-frequency `pointermove`/`mousemove` (perf).

## Layout / CSS reset

- The global reset uses `:where(#bip,#bip *){margin:0;padding:0}` so it has
  **zero specificity** and never overrides the paddings/margins declared by the
  component classes. A plain `#bip *{padding:0}` (id specificity) beats every
  class and collapses the whole layout — that was the root cause of the
  "espremido" (cramped) look. `box-sizing:border-box` stays on `#bip,#bip *`.

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

## CSP (`script-src 'self' 'nonce-…'`)

Sites with a strict CSP and **no `unsafe-eval`** break the loader's
`eval(code)` (`EvalError: … violates the following Content Security Policy
directive … 'unsafe-eval' is not an allowed source of script`). Two layers
handle this:

- **Loader fallback**: when `run()` catches a CSP/eval error, it calls
  `injectPage(code)`, which appends the `user.js` source as an inline
  `<script>` in the **page world**. It copies the page's CSP nonce (read from
  any `script[nonce]`, else the `<head>` HTML) so the script passes. Because the
  loader runs at `document-start` (before the `<head>` is parsed), `injectPage`
  polls up to ~1.2s for a nonce to appear, then injects without one as a last
  resort. It also bails out if `window.__BIP7_LOADED__` is already set.
- **`user.js` fallbacks** (page world has no `GM_*`): `gmGetValue`/`gmSetValue`
  fall back to `localStorage` (`bip:` prefix); `gmAddStyle` appends a `<style>`
  with the page nonce; `gmSetClipboard` uses `navigator.clipboard`. The
  `PAGE_NONCE` is also copied onto the injected page-world hook `<script>` so
  the XHR/fetch interceptor keeps working under strict CSP.

Trade-off: in the CSP path, storage is per-origin (`localStorage`) instead of
shared across sites (GM storage). Since the user.js is idempotent, the top
frame ends up with a single instance and there is no duplicate UI.
  - Validate with a test that runs the real `user.js` in a scope exposing
    `GM_*` only as function parameters (mirrors the TM sandbox): indirect eval
    reproduces the error, direct eval runs clean.

## Roblox port (`burp.lua`)

`burp.lua` is a **faithful port of `user.js` to a Roblox executor script** —
same Burp-Suite-style model (capture, substitution rules, automatic blocking,
and hold → edit → release interception), rebuilt on Roblox Instances.

- **Executor-agnostic compat layer** at the top detects what is available and
  degrades gracefully: the HTTP function (`request`/`http_request`/`syn.request`
  /`http.request`/`fluxus`/`krnl`/`game.HttpRequest`), clipboard
  (`setclipboard`/`toclipboard`), hooking (`hookfunction`/`replaceclosure`,
  `getrawmetatable`/`setreadonly`), file IO (`writefile`/`readfile`/…), and
  task scheduling (`task.spawn`/`delay`/`defer`, else the executor's `spawn`).
- **HTTP core** is `Intercept.perform(method, url, headers, body, kind)`. It
  runs the same pipeline as the userscript: block-list → automatic block rules
  (request phase) → hold-request → send → automatic block rules (response
  phase) → hold-response → substitution rules. It returns
  `status, statusText, headers, body, blocked` and emits captures via
  `Intercept.onCapture` / `Intercept.onHeld`.
- **Hook installation** (`installHooks`) wraps `game:HttpGet`/`HttpPost`,
  `HttpService:RequestAsync`/`GetAsync`/`PostAsync`, and the executor's global
  `request`/`http_request` so calls made by the game flow through `perform`.
  Every wrap is `pcall`-guarded; a blocked call raises an error the hook
  surfaces to the caller.
- **Hold flow** uses a coroutine: `shouldHold(phase)` calls `waitDecision(id)`,
  which yields (`waitFn`) until `Intercept.decide(id, dec)` lands. Same
  `__autoFwd` semantics as the userscript — releasing a request auto-forwards
  its matching response (no second click).
- **UI** is a `ScreenGui` in `CoreGui` (or `gethui()`), built from Instances
  (`UI.build`): header + orb, Send/Receive/Intercept/Config tabs, detail view,
  repeater, intercept editor, config (theme/filter/history), and the
  substitution-rules panel docked to the bottom of the Receive tab. A
  `RunService.Heartbeat` watchdog re-parents the GUI if something detaches it.
- **Persistence** mirrors the userscript: JSON files under a
  `BurpImpure/` folder via the executor's file IO (`fsGet`/`fsSet`), for theme,
  position, orb position, rules, block rules, intercept toggles, and history
  (capped at `MAX_REQ`, bodies truncated). Without file IO everything still
  runs, just without persistence.
- **JSON** is a dependency-free encoder/decoder (`JSON.encode`/`JSON.decode`).
  The encoder **sorts object keys** because Lua tables don't preserve insertion
  order — keeps output deterministic and stable.

### Validating burp.lua without a Roblox client

There is no Lua interpreter in-repo. Validate in two layers:

1. **Syntax**: `python3 -c "from luaparser import ast; ast.parse(open('burp.lua').read())"`
   (`pip install luaparser`). Prints nothing on success.
2. **Runtime**: `pip install lupa` gives a real Lua 5.x runtime. `dofile` the
   script over **strict** Roblox-API stubs (not permissive ones):
   - property setters for `BackgroundColor3`/`TextColor3`/`Color`/… **reject
     strings** (only `Color3`), mirroring the client error
     `invalid value for BackgroundColor3: expected Color3`;
   - only `TextButton`/`ImageButton` expose `MouseButton1Click`, only `TextBox`
     exposes `FocusLost`, so a `Frame:Connect` fails loudly;
   - `AbsoluteContentSize`/`AbsoluteSize` return a `Vector2` with `.X`/`.Y`;
   - a `request` stub that dispatches on the URL (the script captures the
     executor's `request` once at load, so reassigning it later is a no-op).
   Cover: full UI build (`UI.build`/`UI.buildModals`/`renderList`/`renderHeld`/
   `selectTab`), the rules engine (case + var, valid and invalid JSON), block/
   hold/auto-forward, the HTTP hooks, and modal re-open idempotence.
   All checks pass this way. Note `mkToggle` returns a state table with a
   `.frame` (set `.frame.Position`, not `.Position`) and a `.set(on)` method.

### Integration pitfalls fixed after the first port

The first version loaded fine under permissive stubs but broke on a real
executor. Root causes and fixes (all covered by the strict-stub tests):

- **Colors were hex strings.** `S.theme` holds `'#rrggbb'` strings, but
  `BackgroundColor3`/`TextColor3`/`Color` need `Color3`. `new()` now coerces
  any of those props from `#rrggbb` to `Color3` automatically, and the ~13
  direct `inst.XxxColor3 = …` assignments (toggle, tabs, badges, `selectOption`)
  are wrapped in `hex()`.
- **`Parent` was dropped.** `text`/`button`/`box` built the Instance but only
  set `Parent` when the caller passed it in props, so `box(gui, {…})` (root,
  header, tabs) rendered detached. The helpers now pass the first argument as
  the default `Parent`; `new()` applies it when props don't set one.
- **`corner(strip, 2)` on a nil local** in `UI.makeRow` (the strip Frame was
  never assigned).
- **`toggle.MouseButton1Click` on a Frame** in `buildRulesPanel` (Frames have no
  click event); the chevron is now a `TextButton` and the add button is a
  sibling.
- **`HttpService` recursion.** `doHttp`'s fallback called
  `HttpService:RequestAsync`, which `installHooks` had replaced with a wrapper
  that calls `perform` → `doHttp` → … forever. The original `RequestAsync` is
  captured before hooks are installed and used by the fallback.
- **`game:HttpGet`/`HttpPost` arg index.** A colon call passes `game` as `a[1]`,
  so the URL is `a[2]`; the mapper now detects that (`a[1] == game`).
- **Modal listeners accumulated.** `openRuleModal`/`openIcpModal` connected
  their option-button handlers on every open; they are now connected once in
  `buildModals`, and the open functions only set state + sync. The `scope`
  (GET/POST) and `deep` toggles got their missing callbacks.
- **`applyVarRule` fallback used JS-style regex** (`|`, `(?:…)`), which Lua
  patterns don't support. Replaced with a small scanner (`jsonValueEnd`) that
  finds `"key":` and replaces the following JSON value, matching `user.js`'s
  global-replace fallback.
- **`waitDecision` could hang forever** (a request never released). It now
  times out after `DECISION_TIMEOUT` (60s) and auto-forwards.

Note: the response is *not* held when the request was already released
(`autoFwd`), which is the intended one-click-per-transaction behavior ported
from `user.js` (`isAutoFwd`), not a bug.

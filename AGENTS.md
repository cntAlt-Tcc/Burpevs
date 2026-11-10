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

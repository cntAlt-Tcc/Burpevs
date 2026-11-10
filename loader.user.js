// ==UserScript==
// @name         BurpImpure Loader
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Loader que carrega e auto-atualiza o BurpImpure a partir do repositório no GitHub.
// @author       openhands
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @allFrames    true
// @noframes     false
// ==/UserScript==

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     CONFIG
  ═══════════════════════════════════════════════════════════ */

  const REMOTE_URL = 'https://raw.githubusercontent.com/cntAlt-Tcc/Burpevs/refs/heads/main/user.js';
  const CACHE_KEY  = 'bip_loader_cache_v1';  // código mais recente (fonte da verdade)
  const STAMP_KEY  = 'bip_loader_stamp_v1';  // timestamp do último fetch bem-sucedido
  const LAST_CHECK = 'bip_loader_lastcheck_v1';
  const CHECK_MS   = 5 * 60 * 1000;          // intervalo mínimo entre checagens
  const MAX_AGE_MS = 6 * 60 * 60 * 1000;     // idade máxima do cache antes de aguardar a rede

  /* ═══════════════════════════════════════════════════════════
     UTIL
  ═══════════════════════════════════════════════════════════ */

  function run(code) {
    if (!code || typeof code !== 'string') return false;
    if (!/==UserScript==/.test(code)) return false;
    try {
      // Executa no escopo do userscript (não em window) para preservar os
      // grants GM_* do loader — o user.js usa GM_addStyle/GM_setValue/etc.
      (0, eval)(code); // eslint-disable-line no-eval
      return true;
    } catch (e) {
      try { console.error('[BurpImpure Loader] erro ao executar o script:', e); } catch (_) {}
      return false;
    }
  }

  function gmGet(key, def) {
    try { const v = GM_getValue(key, def); return v === undefined ? def : v; }
    catch (_) { return def; }
  }
  function gmSet(key, val) { try { GM_setValue(key, val); } catch (_) {} }

  // Baixa o user.js. Usa GM_xmlhttpRequest (ignora CORS); fallback para fetch.
  function fetchRemote() {
    return new Promise(resolve => {
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: REMOTE_URL + '?t=' + Date.now(), // evita cache do CDN/proxy
            timeout: 20000,
            onload: r => resolve(r && r.status >= 200 && r.status < 300 ? r.responseText : null),
            onerror: () => resolve(null),
            ontimeout: () => resolve(null),
          });
          return;
        } catch (_) { /* cai para fetch */ }
      }
      try {
        fetch(REMOTE_URL + '?t=' + Date.now(), { cache: 'no-store' })
          .then(r => (r.ok ? r.text() : null))
          .then(resolve)
          .catch(() => resolve(null));
      } catch (_) { resolve(null); }
    });
  }

  function applyRemote(code) {
    if (!run(code)) return;
    const now = Date.now();
    gmSet(CACHE_KEY, code);
    gmSet(STAMP_KEY, now);
    gmSet(LAST_CHECK, now);
  }

  /* ═══════════════════════════════════════════════════════════
     BOOT
  ═══════════════════════════════════════════════════════════ */

  const cached = gmGet(CACHE_KEY, null);
  const stamp  = Number(gmGet(STAMP_KEY, 0)) || 0;
  const fresh  = stamp && (Date.now() - stamp) < MAX_AGE_MS;
  const lastCheck = Number(gmGet(LAST_CHECK, 0)) || 0;

  if (cached) {
    // Cache existe: roda imediatamente (mantém @run-at document-start),
    // atualiza em background se já passou o intervalo de checagem.
    run(cached);
    if (Date.now() - lastCheck > CHECK_MS) {
      fetchRemote().then(code => { if (code) applyRemote(code); });
    }
  } else {
    // Primeiro uso (ou cache expirado e sem conteúdo): precisa baixar antes.
    fetchRemote().then(code => {
      if (code) { applyRemote(code); }
      else { try { console.error('[BurpImpure Loader] falha ao baixar o script e sem cache local.'); } catch (_) {} }
    });
  }
})();

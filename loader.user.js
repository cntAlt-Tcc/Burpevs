// ==UserScript==
// @name         BurpImpure Loader
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @description  Loader que carrega e auto-atualiza o BurpImpure a partir do repositório no GitHub.
// @author       openhands
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        GM_info
// @connect      raw.githubusercontent.com
// @run-at       document-start
// @allFrames    true
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

  /* ═══════════════════════════════════════════════════════════
     EXECUÇÃO (com fallback para CSP)
  ═══════════════════════════════════════════════════════════ */

  // Lê o nonce da CSP da página, se houver (para <script> inline passar).
  function pageNonce() {
    try {
      const el = document.querySelector('script[nonce]');
      if (el) { const n = el.nonce || el.getAttribute('nonce'); if (n) return n; }
      const m = document.head && document.head.innerHTML.match(/nonce=["']([^"']+)["']/);
      if (m) return m[1];
    } catch (_) {}
    return '';
  }

  // Injeta o código no page world como <script> inline. Copia o nonce da CSP
  // (se existir) para o script passar; se ainda não houver script com nonce no
  // DOM (o loader roda em document-start, antes do <head> ser parseado), espera
  // um aparecer por até ~1.2s antes de injetar sem nonce como último recurso.
  function injectPage(code, tries) {
    tries = tries || 0;
    try { if (window.__BIP7_LOADED__) return true; } catch (_) {}
    const host = document.documentElement || document.head || document.body;
    if (!host) {
      if (tries < 24) setTimeout(() => injectPage(code, tries + 1), 50);
      return true;
    }
    const nonce = pageNonce();
    if (!nonce && tries < 24) { setTimeout(() => injectPage(code, tries + 1), 50); return true; }
    try {
      const s = document.createElement('script');
      if (nonce) s.setAttribute('nonce', nonce);
      s.textContent = code;
      host.appendChild(s);
      s.remove();
      return true;
    } catch (e) {
      try { console.error('[BurpImpure Loader] falha ao injetar no page world:', e); } catch (_) {}
      return false;
    }
  }

  function run(code) {
    if (!code || typeof code !== 'string') return false;
    if (!/==UserScript==/.test(code)) return false;
    try {
      // eval DIRETO (não `(0, eval)`): o Tampermonkey injeta as funções GM_*
      // no escopo léxico do script, e o eval indireto rodaria no escopo global,
      // onde GM_addStyle/GM_setValue/etc. não existem. O eval direto enxerga
      // esses nomes pela cadeia de escopo do loader.
      eval(code); // eslint-disable-line no-eval
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const csp = /Content Security Policy|unsafe-eval|EvalError/i.test(msg);
      try { console.warn('[BurpImpure Loader] eval falhou' + (csp ? ' (CSP)' : '') + ': ' + msg); } catch (_) {}
      // Sites com CSP estrita bloqueiam eval → roda o script no page world.
      // O user.js tem fallbacks (localStorage / clipboard nativo) para funcionar
      // sem os GM_*.
      if (csp) return injectPage(code);
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

  // Atualização em background: NÃO executa o código novo agora (isso criaria uma
  // segunda instância da UI/interceptor). Apenas guarda no cache; a versão nova
  // passa a valer no próximo carregamento da página.
  function cacheRemote(code) {
    if (!code || typeof code !== 'string') return;
    if (!/==UserScript==/.test(code)) return;
    const now = Date.now();
    gmSet(CACHE_KEY, code);
    gmSet(STAMP_KEY, now);
    gmSet(LAST_CHECK, now);
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
      fetchRemote().then(code => { if (code) cacheRemote(code); });
    }
  } else {
    // Primeiro uso (ou cache expirado e sem conteúdo): precisa baixar antes.
    fetchRemote().then(code => {
      if (code) { applyRemote(code); }
      else { try { console.error('[BurpImpure Loader] falha ao baixar o script e sem cache local.'); } catch (_) {} }
    });
  }
})();

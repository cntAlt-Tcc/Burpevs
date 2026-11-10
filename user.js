// ==UserScript==
// @name         BurpImpure
// @namespace    http://tampermonkey.net/
// @version      7.4
// @description  XHR/Fetch interceptor — Burp Suite style. Clean, fast, responsive.
// @author       Manus & Raro Sec
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @allFrames    true
// ==/UserScript==

(function () {
  'use strict';

  // Guarda de idempotência: impede que uma segunda instância (ex.: loader
  // re-executando o mesmo código, ou loader + user.js instalados juntos)
  // monte outra UI e outro interceptor na mesma página.
  try {
    const de = document.documentElement;
    if (window.__BIP7_LOADED__ || (de && de.dataset.bip7 === '1')) return;
    window.__BIP7_LOADED__ = true;
    if (de) de.dataset.bip7 = '1';
  } catch (_) {}

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════ */

  const SK     = 'bip_theme_v7';
  const OK     = 'bip_orb_v7';
  const PK     = 'bip_pos_v7';
  const RK     = 'bip_rules_v7';
  const MK     = 'bip_min_v7';
  const IK     = 'bip_ign_v7';
  const BK     = 'bip_blk_v7';
  const BRIDGE = '__BIP7__';
  const MAX_REQ = 500; // limite de histórico em memória
  const HK = 'bip_hist_v7';        // histórico persistido entre reloads
  const ICK = 'bip_icp_v7';        // regras de interceptação (hold/drop)
  const PERSIST_MAX  = 200;        // itens máximos persistidos
  const PERSIST_BODY = 5000;       // limite de caracteres por corpo ao persistir

  // Origem válida para o bridge postMessage (fallback '*' em origens opacas, ex.: about:blank)
  const ORIGIN = (location.origin && location.origin !== 'null') ? location.origin : '*';

  // Só a frame principal monta a UI; subframes apenas capturam e repassam.
  // (window.top === window.self lança em frames cross-origin → tratados como subframe.)
  const IS_TOP = (() => { try { return window.top === window.self; } catch (_) { return false; } })();

  const IC = {
    send  : 'https://lmpure.netlify.app/i/1287/enviar-correio.png',
    pkg   : 'https://lmpure.netlify.app/i/1289/entrega-rapida.png',
    recv  : 'https://lmpure.netlify.app/i/1293/entrega-rapida-1-1-.png',
    logo  : 'https://lmpure.netlify.app/i/1295/injection.png',
    edit  : 'https://lmpure.netlify.app/i/1297/editar-texto.png',
    del   : 'https://lmpure.netlify.app/i/1299/excluir.png',
    block : 'https://lmpure.netlify.app/i/1301/bloqueado.png',
  };

  const DT = {
    accent  : '#c8ff00',
    dim     : '#7a9900',
    bg      : '#080808',
    surface : '#0f0f0f',
    raised  : '#161616',
    border  : '#1e1e1e',
    border2 : '#2a2a2a',
    text    : '#e2e2e2',
    sub     : '#888888',
    danger  : '#ff3d3d',
    warn    : '#ffaa00',
    ok      : '#22cc66',
    wpUrl   : '',
    wpOp    : '0.10',
    wpBr    : '1.0',
  };

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */

  const S = {
    reqs      : loadHistory(),
    ignored   : loadSet(IK),
    blocked   : loadSet(BK),
    rules     : loadRules(),
    icp       : loadIcp(),
    icpOn     : loadIcpOn(),
    icpHoldReq: loadIcpHold('holdreq'),
    icpHoldRes: loadIcpHold('holdres'),
    held      : [],
    heldView  : 'send',
    icpEdit   : null,
    filterGet : false,
    cur       : null,
    ready     : false,
    view      : 'send',
    panel     : null,
    minState  : loadMinState(),
    theme     : loadTheme(),
    pos       : loadPos(),
    orbPos    : loadOrbPos(),
  };

  const UI = {};

  /* ═══════════════════════════════════════════════════════════
     STORAGE
  ═══════════════════════════════════════════════════════════ */

  function loadTheme() {
    try { const r = GM_getValue(SK, null); return r ? { ...DT, ...JSON.parse(r) } : { ...DT }; }
    catch { return { ...DT }; }
  }
  function saveTheme() { try { GM_setValue(SK, JSON.stringify(S.theme)); } catch {} }

  function loadPos() {
    try { const r = GM_getValue(PK, null); if (r) { const d = JSON.parse(r); if (isFinite(d.x) && isFinite(d.y)) return d; } } catch {}
    return { x: 14, y: 14 };
  }
  function savePos() { try { GM_setValue(PK, JSON.stringify(S.pos)); } catch {} }

  function loadOrbPos() {
    try { const r = GM_getValue(OK, null); if (r) { const d = JSON.parse(r); if (isFinite(d.x) && isFinite(d.y)) return d; } } catch {}
    return { x: window.innerWidth - 72, y: window.innerHeight - 96 };
  }
  function saveOrbPos() { try { GM_setValue(OK, JSON.stringify(S.orbPos)); } catch {} }

  function loadRules() {
    try { const r = GM_getValue(RK, null); return r ? JSON.parse(r) : []; }
    catch { return []; }
  }
  function saveRules() { try { GM_setValue(RK, JSON.stringify(S.rules)); } catch {} }

  function loadMinState() {
    try { const r = GM_getValue(MK, null); return r ? parseInt(r) : 0; }
    catch { return 0; }
  }
  function saveMinState() { try { GM_setValue(MK, String(S.minState)); } catch {} }

  function loadSet(key) {
    try { const r = GM_getValue(key, null); return new Set(r ? JSON.parse(r) : []); }
    catch { return new Set(); }
  }
  function saveSet(key, set) { try { GM_setValue(key, JSON.stringify([...set])); } catch {} }

  // ── Histórico persistido entre reloads e entre sites ──
  function truncBody(b) {
    if (b == null) return b;
    const s = typeof b === 'string' ? b : String(b);
    return s.length > PERSIST_BODY ? s.slice(0, PERSIST_BODY) + '\n…[truncado ao salvar]' : s;
  }
  function loadHistory() {
    try {
      const r = GM_getValue(HK, null);
      if (!r) return [];
      const a = JSON.parse(r);
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }

  // Grava o histórico AGORA (síncrono). Só a frame principal persiste, e uma
  // lista vazia nunca sobrescreve o histórico salvo (só com `force`, usado pelo
  // botão Clear) — assim nenhuma frame/timing apaga o histórico por acidente.
  function persistHistoryNow(force) {
    if (!IS_TOP) return;
    if (!force && !S.reqs.length) { __histDirty = false; return; }
    try {
      const out = S.reqs.slice(0, PERSIST_MAX).map(r => ({
        ...r,
        reqB: truncBody(r.reqB),
        resB: truncBody(r.resB),
      }));
      GM_setValue(HK, JSON.stringify(out));
      __histDirty = false;
    } catch (_) {}
  }

  let __histT = null, __histDirty = false;

  function saveHistory() {
    if (!IS_TOP) return;
    __histDirty = true;
    if (__histT) return;
    // Em aba oculta o setTimeout é fortemente estrangulado (ou descartado) pelo
    // navegador; grava na hora para não perder histórico ao trocar de site/aba
    // ou fechar o navegador.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { persistHistoryNow(); return; }
    __histT = setTimeout(() => { __histT = null; persistHistoryNow(); }, 400);
  }

  // Flush imediato (pagehide/beforeunload/aba oculta): cancela o debounce e
  // grava sem esperar, garantindo a persistência na saída da página.
  function flushHistory() {
    if (__histT) { clearTimeout(__histT); __histT = null; }
    if (__histDirty) persistHistoryNow();
  }

  // ── Regras de BLOQUEIO automático (a antiga ação "segurar" foi removida: agora
  //    segurar é o modo global ligado pelo master). Regras antigas de "hold" são
  //    descartadas na migração para não bloquear tráfego sem intenção.
  function loadIcp() {
    try {
      const r = GM_getValue(ICK, null); const a = r ? JSON.parse(r) : [];
      if (!Array.isArray(a)) return [];
      return a.filter(x => x && x.action !== 'hold')
              .map(x => ({
                url   : x.url || '',
                method: String(x.method || 'ANY').toUpperCase(),
                phase : x.phase || 'request',
                enabled: x.enabled !== false,
              }));
    } catch { return []; }
  }
  function saveIcp() { try { GM_setValue(ICK, JSON.stringify(S.icp)); } catch {} }

  // Flag global de interceptação (ligada/desligada)
  function loadIcpOn() { try { return GM_getValue(ICK + '_on', '0') === '1'; } catch { return false; } }
  function saveIcpOn() { try { GM_setValue(ICK + '_on', S.icpOn ? '1' : '0'); } catch {} }

  // Segurar envio (request) / recepção (response) quando a interceptação está ligada
  function loadIcpHold(which) { try { return GM_getValue(ICK + '_' + which, '1') === '1'; } catch { return true; } }
  function saveIcpHold(which, v) { try { GM_setValue(ICK + '_' + which, v ? '1' : '0'); } catch {} }

  /* ═══════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════ */

  const esc = t => String(t)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const tryJson = t => { try { return JSON.parse(t); } catch { return null; } };

  function scls(s) {
    const n = Number(s);
    if (n >= 500) return 's5';
    if (n >= 400) return 's4';
    if (n >= 300) return 's3';
    if (n >= 200) return 's2';
    return 'sx';
  }

  function fmtUrl(u) { try { return new URL(u, location.href).href; } catch { return String(u||''); } }

  function shortUrl(u) {
    try {
      const p = new URL(u);
      let s = p.hostname + p.pathname;
      if (s.length > 52) s = s.slice(0, 50) + '…';
      return s;
    } catch { return String(u||'').slice(0, 52); }
  }

  function getHdr(h, name) {
    if (!h) return '';
    const l = name.toLowerCase();
    if (h instanceof Headers) return h.get(l) || '';
    if (Array.isArray(h)) { const f = h.find(([k]) => k.toLowerCase() === l); return f ? f[1] : ''; }
    return h[name] || h[l] || '';
  }

  // Envia regras ativas + lista de bloqueados + config de interceptação para o contexto da página
  function pushRulesToPage() {
    const active = S.rules.filter(r => r.enabled);
    const icp = (S.icp || []).filter(r => r.enabled).map(r => ({
      url: r.url || '', method: (r.method || 'ANY').toUpperCase(),
      phase: r.phase || 'request',
    }));
    try {
      window.postMessage({ __BIP_RULES__: true, bridge: BRIDGE, rules: active, blocked: [...S.blocked], icp, icpOn: S.icpOn,
        holdReq: S.icpHoldReq, holdRes: S.icpHoldRes }, ORIGIN);
    } catch {}
  }

  async function bodyText(body, ct) {
    if (body == null || body === '') return '[Empty]';
    if (typeof body === 'string') {
      const t = body.trim();
      if (!t) return '[Empty]';
      const p = tryJson(t);
      return p !== null ? JSON.stringify(p, null, 2) : body;
    }
    if (body instanceof FormData) {
      const o = {};
      for (const [k,v] of body.entries()) o[k] = v instanceof File ? `[File: ${v.name}]` : v;
      return JSON.stringify(o, null, 2);
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) {
      try { const t = await body.text(); const p = ct?.includes('json') ? tryJson(t) : null; return p ? JSON.stringify(p,null,2) : t; }
      catch { return `[Blob ${body.size}B]`; }
    }
    if (typeof body === 'object') { try { return JSON.stringify(body, null, 2); } catch {} }
    return String(body);
  }

  function relTime(ts) {
    const d = Date.now() - new Date(ts).getTime();
    if (d < 1000) return 'just now';
    if (d < 60000) return Math.floor(d/1000) + 's ago';
    if (d < 3600000) return Math.floor(d/60000) + 'm ago';
    return new Date(ts).toLocaleTimeString();
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    const c  = type === 'ok' ? '#22cc66' : '#ff3d3d';
    Object.assign(el.style, {
      position:'fixed', bottom:'72px', right:'14px', zIndex:'2147483647',
      background:'#111', border:`1px solid ${c}`, color:c,
      padding:'7px 13px', borderRadius:'4px', fontSize:'11px', fontWeight:'700',
      fontFamily:'Consolas,monospace', boxShadow:'0 4px 20px rgba(0,0,0,.7)',
      opacity:'0', transition:'opacity .14s', pointerEvents:'none',
    });
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 150); }, 2400);
  }

  /* ═══════════════════════════════════════════════════════════
     CSS
  ═══════════════════════════════════════════════════════════ */

  function injectCSS() {
    GM_addStyle(`
/* ── scope reset ── */
#bip,#bip *{box-sizing:border-box;margin:0;padding:0;}
#bip{font-family:Consolas,Monaco,'Courier New',monospace;font-size:12px;}

/* ── CSS custom properties ── */
#bip{
  --a:${S.theme.accent};--dim:${S.theme.dim};
  --bg:${S.theme.bg};--sf:${S.theme.surface};--ra:${S.theme.raised};
  --bd:${S.theme.border};--bd2:${S.theme.border2};
  --tx:${S.theme.text};--sub:${S.theme.sub};
  --dn:${S.theme.danger};--ok:${S.theme.ok};--wn:${S.theme.warn};
  --wp:${S.theme.wpUrl?`url("${S.theme.wpUrl.replace(/"/g,'%22')}")`:'none'};
  --wo:${S.theme.wpOp};--wb:${S.theme.wpBr};
}

/* ── main window ── */
#bip{
  position:fixed;
  top:0;left:0;
  width:clamp(320px,var(--bw,520px),96vw);
  height:clamp(260px,var(--bh,680px),90vh);
  background:var(--bg);
  border:1px solid var(--bd2);
  border-radius:8px;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  color:var(--tx);
  z-index:2147483647!important;
  box-shadow:0 0 0 1px rgba(0,0,0,.9),0 24px 64px rgba(0,0,0,.8),0 0 40px rgba(0,0,0,.4);
  transition:width .22s ease,height .22s ease;
  contain:layout style;
  will-change:transform;
}

/* wallpaper */
#bip::before{
  content:'';position:absolute;inset:0;pointer-events:none;z-index:0;
  background-image:var(--wp);background-size:cover;background-position:center;
  opacity:var(--wo);filter:brightness(var(--wb));
}
#bip>*{position:relative;z-index:1;}

/* PiP mode */
#bip.pip{
  width:280px!important;
  height:auto!important;
  min-height:0!important;
  border-radius:6px;
}
#bip.pip #bip-tabs,
#bip.pip #bip-body{display:none;}
#bip.pip #bip-pip-list{display:flex!important;}

/* pip list */
#bip-pip-list{
  display:none;
  flex-direction:column;
  max-height:180px;
  overflow-y:auto;
  border-top:1px solid var(--bd);
}
#bip-pip-list::-webkit-scrollbar{width:3px;}
#bip-pip-list::-webkit-scrollbar-thumb{background:var(--bd2);}

.pip-row{
  display:flex;align-items:center;gap:8px;
  padding:6px 10px;border-bottom:1px solid var(--bd);
  cursor:pointer;transition:background .1s;
}
.pip-row:last-child{border-bottom:none;}
.pip-row:hover{background:var(--sf);}
.pip-row .pm{font-size:9px;font-weight:700;color:var(--a);min-width:34px;flex-shrink:0;}
.pip-row .pu{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px;color:var(--sub);}
.pip-row .ps{font-size:9px;font-weight:700;}

/* ── HEADER ── */
#bip-hdr{
  height:38px;min-height:38px;flex-shrink:0;
  display:flex;align-items:center;gap:0;
  background:var(--sf);
  border-bottom:1px solid var(--bd2);
  cursor:grab;user-select:none;touch-action:none;
  padding:0 8px 0 10px;
}
#bip-hdr:active{cursor:grabbing;}

.hdr-logo{width:15px;height:15px;object-fit:contain;margin-right:7px;opacity:.9;}
.hdr-title{font-size:11px;font-weight:700;color:var(--a);letter-spacing:.05em;margin-right:7px;}
.hdr-badge{
  background:rgba(200,255,0,.1);border:1px solid rgba(200,255,0,.18);
  color:var(--a);border-radius:3px;padding:1px 5px;
  font-size:9px;font-weight:700;letter-spacing:.04em;margin-right:auto;
}
.hdr-sep{width:1px;height:18px;background:var(--bd2);margin:0 4px;flex-shrink:0;}

/* ── HEADER BUTTONS — polished ── */
.hbtn{
  height:26px;padding:0 10px;
  border:1px solid var(--bd2);
  background:transparent;
  color:var(--sub);
  border-radius:4px;cursor:pointer;
  font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  display:inline-flex;align-items:center;gap:5px;
  transition:all .13s ease;
  flex-shrink:0;margin-left:3px;
  font-family:Consolas,monospace;
  position:relative;overflow:hidden;
}
.hbtn::before{
  content:'';position:absolute;inset:0;opacity:0;
  transition:opacity .13s;background:currentColor;
}
.hbtn:hover::before{opacity:.07;}
.hbtn img{width:11px;height:11px;object-fit:contain;opacity:.45;transition:opacity .13s;flex-shrink:0;}
.hbtn:hover{color:var(--tx);border-color:var(--bd2);box-shadow:0 2px 8px rgba(0,0,0,.4);}
.hbtn:hover img{opacity:.85;}
.hbtn:active{transform:scale(.94);}

.hbtn.pip-btn{color:#5599ee;}
.hbtn.pip-btn:hover{border-color:#4488ff44;box-shadow:0 0 12px rgba(68,136,255,.12),0 2px 8px rgba(0,0,0,.4);}
.hbtn.orb-btn{color:var(--wn);}
.hbtn.orb-btn:hover{border-color:#ffaa0033;box-shadow:0 0 12px rgba(255,170,0,.12),0 2px 8px rgba(0,0,0,.4);}
.hbtn.close-btn{color:#ff6666;}
.hbtn.close-btn:hover{border-color:#ff333333;color:var(--dn);box-shadow:0 0 12px rgba(255,61,61,.12),0 2px 8px rgba(0,0,0,.4);}

/* ── TABS ── */
#bip-tabs{
  display:flex;flex-shrink:0;
  background:var(--bg);
  border-bottom:1px solid var(--bd);
}
.tab{
  flex:1;height:32px;border:none;background:transparent;
  color:var(--sub);cursor:pointer;font-size:10px;font-weight:700;
  letter-spacing:.05em;text-transform:uppercase;
  display:inline-flex;align-items:center;justify-content:center;gap:5px;
  border-bottom:2px solid transparent;
  transition:color .12s,border-color .12s,background .12s;
  font-family:Consolas,monospace;
}
.tab img{width:12px;height:12px;object-fit:contain;opacity:.5;transition:opacity .12s;}
.tab:hover{color:var(--tx);background:rgba(255,255,255,.02);}
.tab:hover img{opacity:.75;}
.tab.on{color:var(--a);border-bottom-color:var(--a);background:rgba(200,255,0,.03);}
.tab.on img{opacity:1;}
.tab-count{
  font-size:8px;font-weight:700;background:rgba(200,255,0,.12);
  border:1px solid rgba(200,255,0,.2);color:var(--a);
  border-radius:2px;padding:0 3px;min-width:14px;text-align:center;
}
.tab-count:empty{display:none;}

/* ── BODY ── */
#bip-body{
  position:relative;flex:1;min-height:0;overflow:hidden;
}

/* ── PAGES ── */
.page{
  position:absolute;inset:0;display:none;
  flex-direction:column;overflow-y:auto;
}
.page.on{display:flex;}
.page::-webkit-scrollbar{width:3px;}
.page::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:2px;}

/* ── INTERCEPT RULES PANEL ── */
#rules-panel{
  flex-shrink:0;
  border-bottom:1px solid var(--bd2);
  background:var(--sf);
}
.rules-header{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;cursor:pointer;user-select:none;
  transition:background .1s;
}
.rules-header:hover{background:rgba(255,255,255,.025);}
.rules-icon{width:12px;height:12px;object-fit:contain;opacity:.6;flex-shrink:0;}
.rules-title{font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--sub);flex:1;}
.rules-badge{
  font-size:8px;font-weight:700;padding:1px 5px;border-radius:2px;
  background:rgba(200,255,0,.1);border:1px solid rgba(200,255,0,.2);color:var(--a);
}
.rules-chevron{
  font-size:8px;color:var(--sub);transition:transform .18s;
  line-height:1;flex-shrink:0;
}
.rules-chevron.open{transform:rotate(90deg);}

.rules-add-btn{
  height:22px;padding:0 8px;border-radius:3px;
  border:1px solid rgba(200,255,0,.2);
  background:rgba(200,255,0,.06);
  color:var(--a);font-size:8px;font-weight:800;letter-spacing:.06em;
  cursor:pointer;font-family:Consolas,monospace;
  display:inline-flex;align-items:center;gap:4px;
  transition:all .12s;flex-shrink:0;
}
.rules-add-btn:hover{background:rgba(200,255,0,.12);border-color:rgba(200,255,0,.35);box-shadow:0 0 8px rgba(200,255,0,.08);}
.rules-add-btn:active{transform:scale(.94);}

.rules-body{
  display:none;
  flex-direction:column;
  max-height:160px;
  overflow-y:auto;
  border-top:1px solid var(--bd);
}
.rules-body.open{display:flex;}
.rules-body::-webkit-scrollbar{width:3px;}
.rules-body::-webkit-scrollbar-thumb{background:var(--bd2);}

.rules-empty{
  padding:12px;text-align:center;
  font-size:10px;color:var(--sub);
  font-style:italic;
}

.rule-row{
  display:flex;align-items:center;gap:6px;
  padding:5px 10px;border-bottom:1px solid var(--bd);
  transition:background .1s;
}
.rule-row:last-child{border-bottom:none;}
.rule-row:hover{background:rgba(255,255,255,.02);}

.rule-texts{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.rule-find{
  font-size:9px;color:var(--dn);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.rule-replace{
  font-size:9px;color:var(--ok);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.rule-arrow{font-size:9px;color:var(--sub);margin:0 2px;flex-shrink:0;}

.rule-tog{
  width:28px;height:16px;position:relative;flex-shrink:0;cursor:pointer;
}
.rule-tog input{opacity:0;width:0;height:0;position:absolute;}
.rule-tog-sl{
  position:absolute;inset:0;background:#222;border-radius:999px;
  cursor:pointer;transition:.15s;border:1px solid var(--bd2);
}
.rule-tog-sl::before{
  content:'';position:absolute;
  width:10px;height:10px;left:2px;top:2px;
  background:#555;border-radius:50%;transition:.15s;
}
.rule-tog input:checked+.rule-tog-sl{background:rgba(34,204,102,.25);border-color:rgba(34,204,102,.4);}
.rule-tog input:checked+.rule-tog-sl::before{transform:translateX(12px);background:var(--ok);}

.rule-btn{
  width:22px;height:22px;border-radius:3px;border:1px solid var(--bd);
  background:var(--ra);color:var(--sub);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  transition:all .12s;flex-shrink:0;padding:0;
}
.rule-btn img{width:11px;height:11px;object-fit:contain;opacity:.5;transition:opacity .12s;}
.rule-btn:hover{border-color:var(--bd2);}
.rule-btn:hover img{opacity:.9;}
.rule-btn.edit-btn:hover{background:rgba(68,136,255,.1);border-color:rgba(68,136,255,.3);}
.rule-btn.del-btn:hover{background:rgba(255,61,61,.1);border-color:rgba(255,61,61,.3);}
.rule-btn:active{transform:scale(.88);}

/* ── INTERCEPT PAGE ── */
.icp-body{display:flex;flex-direction:column;gap:2px;padding-bottom:10px;}
.icp-head{
  display:flex;align-items:center;gap:8px;
  padding:8px 10px;border-bottom:1px solid var(--bd);
}
.icp-head-lbl{font-size:10px;font-weight:700;color:var(--tx);letter-spacing:.03em;}
#icp-state{font-weight:700;text-transform:uppercase;font-size:9px;}
#icp-rules,#icp-held{display:flex;flex-direction:column;}

/* toggles de segurar envio/recepção */
.icp-holds{display:flex;gap:14px;padding:6px 10px;border-bottom:1px solid var(--bd);}
.icp-hold-opt{display:flex;align-items:center;gap:5px;font-size:9px;color:var(--sub);cursor:pointer;user-select:none;}
.icp-hold-opt input{accent-color:var(--a);width:12px;height:12px;cursor:pointer;}

/* sub-abas Send / Get */
.icp-tabs{display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid var(--bd);}
.icp-tab{
  background:none;border:none;border-bottom:2px solid transparent;
  color:var(--sub);font-family:inherit;font-size:9px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;padding:6px 8px;cursor:pointer;display:flex;align-items:center;gap:4px;
}
.icp-tab:hover{color:var(--tx);}
.icp-tab.on{color:var(--a);border-bottom-color:var(--a);}

/* badge de fase no editor */
.ie-phase{font-size:8px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border-radius:3px;flex-shrink:0;}
.ie-phase.is-req{background:rgba(68,136,255,.18);color:#6aa0ff;}
.ie-phase.is-res{background:rgba(34,204,102,.18);color:var(--ok);}
.ie-meta{margin-bottom:4px;}

.held-row{
  display:flex;flex-direction:column;gap:6px;
  padding:8px 10px;border-bottom:1px solid var(--bd);
  background:rgba(255,193,7,.04);
}
.held-top{display:flex;align-items:center;gap:6px;min-width:0;}
.held-phase{
  font-size:8px;font-weight:700;letter-spacing:.06em;
  padding:1px 5px;border-radius:3px;flex-shrink:0;
}
.held-phase.is-req{background:rgba(68,136,255,.18);color:#6aa0ff;}
.held-phase.is-res{background:rgba(34,204,102,.18);color:var(--ok);}
.held-url{
  font-size:9px;color:var(--sub);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;
}
.held-acts{display:flex;gap:6px;}
.held-acts .abtn{flex:1;}

/* ── REQUEST LIST ── */
.req-list{display:flex;flex-direction:column;flex:1;}

.req-item{
  display:flex;align-items:center;gap:0;
  border-bottom:1px solid var(--bd);
  padding:0;cursor:pointer;
  transition:background .1s;
  min-height:0;
}
.req-item:hover{background:var(--sf);}
.req-item:hover .ri-method{color:var(--a);}

.ri-strip{width:3px;height:100%;min-height:38px;flex-shrink:0;background:var(--bd2);transition:background .1s;}
.req-item:hover .ri-strip{background:var(--dim);}
.req-item.is-post .ri-strip{background:rgba(68,136,255,.45);}
.req-item.is-del  .ri-strip{background:rgba(255,61,61,.45);}
.req-item.is-put  .ri-strip{background:rgba(255,170,0,.45);}
.req-item.is-4xx  .ri-strip{background:rgba(255,100,30,.3);}
.req-item.is-5xx  .ri-strip{background:rgba(255,61,61,.3);}

.ri-inner{display:flex;align-items:center;gap:0;flex:1;min-width:0;padding:7px 10px;}
.ri-method{font-size:9px;font-weight:700;color:var(--sub);min-width:36px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em;}
.ri-url{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:var(--tx);margin:0 8px;}
.ri-right{display:flex;align-items:center;gap:6px;flex-shrink:0;}
.ri-status{font-size:10px;font-weight:700;}
.ri-type{font-size:8px;color:var(--sub);border:1px solid var(--bd);border-radius:2px;padding:1px 4px;text-transform:uppercase;letter-spacing:.04em;}
.ri-time{font-size:9px;color:var(--sub);}

.s2{color:#3de87a;}.s3{color:#ffd44d;}.s4{color:#ff8c42;}.s5{color:#ff4d4d;}.sx{color:var(--sub);}

/* rule-patched indicator */
.req-item.rule-hit .ri-type{border-color:rgba(200,255,0,.3);color:var(--a);}

/* empty */
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;}
.empty-state img{width:28px;height:28px;opacity:.2;}
.empty-state p{font-size:11px;color:var(--sub);text-align:center;line-height:1.5;}

/* ── OVERLAYS ── */
.overlay{position:absolute;inset:0;display:none;flex-direction:column;background:var(--bg);z-index:20;animation:ov-in .14s ease;}
.overlay.on{display:flex;}
@keyframes ov-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}

.ov-hdr{
  height:38px;min-height:38px;flex-shrink:0;
  display:flex;align-items:center;gap:8px;
  background:var(--sf);border-bottom:1px solid var(--bd2);
  padding:0 8px;
}
.ov-title{flex:1;min-width:0;font-size:11px;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

/* ── DETAIL ── */
.det-scroll{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;}
.det-scroll::-webkit-scrollbar{width:3px;}
.det-scroll::-webkit-scrollbar-thumb{background:var(--bd2);}

.det-meta{display:grid;grid-template-columns:80px 1fr;gap:3px 10px;padding:10px;background:var(--sf);border:1px solid var(--bd);border-radius:5px;margin-bottom:12px;}
.det-meta .k{font-size:9px;font-weight:700;color:var(--sub);text-transform:uppercase;letter-spacing:.06em;padding-top:1px;}
.det-meta .v{font-size:11px;color:var(--tx);word-break:break-all;}
.det-meta .v.url-val{color:var(--a);font-size:10px;}

.sec-label{font-size:8px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sub);margin:12px 0 5px;display:flex;align-items:center;gap:6px;}
.sec-label::after{content:'';flex:1;height:1px;background:var(--bd);}

.rule-applied-badge{
  font-size:8px;font-weight:700;padding:1px 6px;border-radius:2px;
  background:rgba(200,255,0,.1);border:1px solid rgba(200,255,0,.2);
  color:var(--a);margin-left:6px;letter-spacing:.05em;
}

.code-block{
  background:var(--sf);border:1px solid var(--bd);border-radius:4px;
  padding:10px;font-size:10px;line-height:1.55;color:var(--tx);
  white-space:pre-wrap;word-break:break-all;overflow-x:auto;
  max-height:200px;overflow-y:auto;
}
.code-block::-webkit-scrollbar{width:3px;height:3px;}
.code-block::-webkit-scrollbar-thumb{background:var(--bd2);}

/* ── ACTION BAR ── */
.act-bar{
  display:flex;gap:5px;padding:8px 10px;
  background:var(--sf);border-top:1px solid var(--bd2);
  flex-shrink:0;flex-wrap:wrap;align-items:center;
}

/* ── POLISHED ACTION BUTTONS ── */
.abtn{
  height:28px;padding:0 11px;border-radius:4px;border:1px solid transparent;
  cursor:pointer;font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
  display:inline-flex;align-items:center;gap:5px;
  transition:all .12s ease;
  font-family:Consolas,monospace;white-space:nowrap;
  position:relative;overflow:hidden;
}
.abtn::before{content:'';position:absolute;inset:0;opacity:0;transition:opacity .12s;background:rgba(255,255,255,.06);}
.abtn:hover::before{opacity:1;}
.abtn img{width:12px;height:12px;object-fit:contain;flex-shrink:0;opacity:.7;transition:opacity .12s;}
.abtn:hover img{opacity:1;}
.abtn:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.5);}
.abtn:active{transform:scale(.94) translateY(0);filter:brightness(.88);}

.abtn-rep  {background:#0d2044;border-color:#1a3a66;color:#7ab8ff;}
.abtn-copy {background:#18183a;border-color:#282878;color:#aaaaff;}
.abtn-ign  {background:#2a1e00;border-color:#664e00;color:#ffcc44;}
.abtn-blk  {background:#280808;border-color:#661616;color:#ff7777;}
.abtn-send {background:#071e07;border-color:#1a5a1a;color:#55ee66;}
.abtn-clr  {background:#200808;border-color:#661010;color:#ff5555;}
.abtn-rst  {background:var(--ra);border-color:var(--bd2);color:var(--sub);}
.abtn-back {background:var(--ra);border-color:var(--bd2);color:var(--tx);}
.abtn-appl {background:#101e04;border-color:#2e5208;color:var(--a);}
.abtn-add  {background:#0e1e08;border-color:rgba(200,255,0,.25);color:var(--a);}
.abtn-save {background:#071a07;border-color:#226622;color:var(--ok);}

/* ── REPEATER ── */
.rep-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
.rep-body::-webkit-scrollbar{width:3px;}
.rep-body::-webkit-scrollbar-thumb{background:var(--bd2);}
.rep-row2{display:grid;grid-template-columns:120px 1fr;gap:8px;}
.fgroup{display:flex;flex-direction:column;gap:4px;}
.flabel{font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sub);}
.finput,.ftextarea{
  background:var(--sf);border:1px solid var(--bd2);border-radius:3px;
  color:var(--tx);padding:7px 9px;
  font-family:Consolas,Monaco,monospace;font-size:11px;
  outline:none;width:100%;transition:border-color .1s,box-shadow .1s;
}
.finput:focus,.ftextarea:focus{border-color:var(--a);box-shadow:0 0 0 2px rgba(200,255,0,.06);}
.ftextarea{min-height:80px;resize:vertical;line-height:1.45;}
.ftextarea.tall{min-height:110px;}
.prev-box{background:var(--sf);border:1px solid var(--bd);border-radius:4px;padding:10px;font-size:10px;color:var(--dim);white-space:pre-wrap;word-break:break-word;min-height:60px;line-height:1.5;}

/* ── CONFIG ── */
.cfg-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:0;}
.cfg-body::-webkit-scrollbar{width:3px;}
.cfg-body::-webkit-scrollbar-thumb{background:var(--bd2);}
.cfg-section{margin-bottom:18px;}
.cfg-heading{font-size:8px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sub);padding-bottom:6px;border-bottom:1px solid var(--bd);margin-bottom:8px;}
.cfg-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03);}
.cfg-row:last-child{border-bottom:none;}
.cfg-row label{font-size:11px;color:var(--tx);cursor:pointer;}

.tog{position:relative;width:36px;height:20px;flex-shrink:0;}
.tog input{opacity:0;width:0;height:0;position:absolute;}
.tog-sl{position:absolute;inset:0;background:#2a2a2a;border-radius:999px;cursor:pointer;transition:.15s;border:1px solid var(--bd2);}
.tog-sl::before{content:'';position:absolute;width:12px;height:12px;left:3px;top:3px;background:#888;border-radius:50%;transition:.15s;}
.tog input:checked+.tog-sl{background:var(--a);border-color:var(--dim);}
.tog input:checked+.tog-sl::before{transform:translateX(16px);background:#000;}

.color-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px;}
@media(max-width:360px){.color-grid{grid-template-columns:repeat(2,1fr);}}
.c-item{display:flex;flex-direction:column;gap:3px;}
.c-label{font-size:8px;color:var(--sub);text-transform:uppercase;letter-spacing:.05em;}
.c-swatch{width:100%;height:28px;border:1px solid var(--bd2);border-radius:3px;padding:2px;cursor:pointer;background:var(--sf);}

.range-row{display:flex;align-items:center;gap:7px;padding:4px 0;}
.range-row input[type=range]{flex:1;accent-color:var(--a);height:3px;}
.range-val{font-size:9px;color:var(--sub);min-width:36px;text-align:right;font-weight:700;}
.size-label{font-size:9px;color:var(--sub);margin-bottom:3px;}

/* ── RULE MODAL ── */
#rule-modal-bg{
  display:none;position:fixed;inset:0;z-index:2147483648!important;
  background:rgba(0,0,0,.7);
  align-items:center;justify-content:center;
  backdrop-filter:blur(2px);
}
#rule-modal-bg.on{display:flex;}

#icp-modal-bg{
  display:none;position:fixed;inset:0;z-index:2147483648!important;
  background:rgba(0,0,0,.7);
  align-items:center;justify-content:center;
  backdrop-filter:blur(2px);
}
#icp-modal-bg.on{display:flex;}

#icp-modal{
  background:var(--bg,#080808);
  border:1px solid var(--bd2,#2a2a2a);
  border-radius:8px;
  width:min(440px,92vw);
  overflow:hidden;
  box-shadow:0 0 0 1px rgba(0,0,0,.9),0 24px 64px rgba(0,0,0,.9);
  font-family:Consolas,Monaco,monospace;
  animation:ov-in .14s ease;
}
.rm-row2{display:flex;gap:8px;align-items:flex-end;}
.rm-row2 .rm-field{flex:1;min-width:0;}
#icp-modal select.finput{width:100%;}

#rule-modal{
  background:var(--bg,#080808);
  border:1px solid var(--bd2,#2a2a2a);
  border-radius:8px;
  width:min(380px,92vw);
  overflow:hidden;
  box-shadow:0 0 0 1px rgba(0,0,0,.9),0 24px 64px rgba(0,0,0,.9);
  font-family:Consolas,Monaco,monospace;
  animation:ov-in .14s ease;
}
.rm-hdr{
  display:flex;align-items:center;gap:8px;
  padding:10px 14px;
  background:var(--sf,#0f0f0f);border-bottom:1px solid var(--bd2,#2a2a2a);
}
.rm-title{flex:1;font-size:11px;font-weight:700;color:var(--tx,#e2e2e2);letter-spacing:.04em;}
.rm-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px;}
.rm-row{display:flex;align-items:center;gap:8px;}
.rm-arrow{font-size:14px;color:var(--sub,#888);flex-shrink:0;}
.rm-footer{
  display:flex;gap:6px;justify-content:flex-end;
  padding:10px 14px;
  background:var(--sf,#0f0f0f);border-top:1px solid var(--bd2,#2a2a2a);
}
.rm-label{font-size:8px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sub,#888);margin-bottom:4px;}
.rm-field{flex:1;}
.rm-hint{font-size:9px;color:var(--sub,#888);line-height:1.4;padding:5px 8px;background:rgba(255,255,255,.03);border-radius:3px;border:1px solid var(--bd,#1e1e1e);}

/* mode selector */
.rm-mode-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.rm-mode-btn{
  display:flex;flex-direction:column;gap:2px;align-items:flex-start;
  padding:8px 10px;border-radius:5px;cursor:pointer;
  border:1px solid var(--bd2,#2a2a2a);background:var(--ra,#161616);
  transition:all .13s;font-family:Consolas,monospace;text-align:left;
}
.rm-mode-btn:hover{border-color:var(--bd2,#2a2a2a);background:rgba(255,255,255,.04);}
.rm-mode-btn.active{border-color:rgba(200,255,0,.4);background:rgba(200,255,0,.06);}
.rm-mode-icon{font-size:14px;font-weight:700;color:var(--sub,#888);transition:color .13s;line-height:1;}
.rm-mode-btn.active .rm-mode-icon{color:var(--a,#c8ff00);}
.rm-mode-label{font-size:10px;font-weight:700;color:var(--tx,#e2e2e2);letter-spacing:.03em;}
.rm-mode-desc{font-size:8px;color:var(--sub,#888);line-height:1.3;}

/* opts toggles */
.rm-opts-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:4px 0;}
.rm-opt-tog{
  display:inline-flex;align-items:center;gap:5px;cursor:pointer;
  padding:4px 7px;border-radius:3px;border:1px solid var(--bd,#1e1e1e);
  background:var(--ra,#161616);transition:all .12s;
}
.rm-opt-tog:hover{border-color:var(--bd2,#2a2a2a);}
.rm-opt-tog input{display:none;}
.rm-opt-sl{
  width:22px;height:12px;border-radius:999px;
  background:#333;border:1px solid #444;
  position:relative;flex-shrink:0;transition:.15s;
}
.rm-opt-sl::before{
  content:'';position:absolute;
  width:8px;height:8px;left:1px;top:1px;
  background:#666;border-radius:50%;transition:.15s;
}
.rm-opt-tog input:checked ~ .rm-opt-sl{background:rgba(200,255,0,.2);border-color:rgba(200,255,0,.4);}
.rm-opt-tog input:checked ~ .rm-opt-sl::before{transform:translateX(10px);background:var(--a,#c8ff00);}
.rm-opt-tog input:checked ~ .rm-opt-lbl{color:var(--a,#c8ff00);}
.rm-opt-lbl{font-size:9px;font-weight:700;color:var(--sub,#888);letter-spacing:.05em;transition:color .12s;}
.rm-opt-tog.disabled{opacity:.35;pointer-events:none;}

/* ── ORB ── */
#bip-orb{
  position:fixed;display:none;
  width:48px;height:48px;border-radius:50%;
  z-index:2147483647!important;cursor:grab;user-select:none;
  background:radial-gradient(circle at 38% 38%,rgba(255,255,255,.12),transparent 52%),var(--bg,#080808);
  border:1px solid rgba(200,255,0,.6);
  box-shadow:0 0 24px rgba(200,255,0,.15),0 6px 20px rgba(0,0,0,.6);
  align-items:center;justify-content:center;flex-direction:column;gap:2px;
  transition:box-shadow .15s;
}
#bip-orb.on{display:flex;}
#bip-orb:hover{box-shadow:0 0 32px rgba(200,255,0,.25),0 6px 20px rgba(0,0,0,.6);}
#bip-orb img{width:16px;height:16px;object-fit:contain;}
#bip-orb-n{font-size:8px;font-weight:700;color:rgba(200,255,0,.8);font-family:Consolas,monospace;}

/* ── RESIZE HANDLE ── */
#bip-resize{
  position:absolute;bottom:0;right:0;
  width:14px;height:14px;cursor:se-resize;z-index:30;
  background:linear-gradient(135deg,transparent 50%,var(--bd2) 50%);
  opacity:.6;transition:opacity .12s;
}
#bip-resize:hover{opacity:1;}

/* ── ENTRY ANIMATION ── */
@keyframes bip-pop{from{opacity:0;transform:translate3d(var(--bx,14px),calc(var(--by,14px) + 8px),0);}to{opacity:1;transform:translate3d(var(--bx,14px),var(--by,14px),0);}}
#bip.entering{animation:bip-pop .18s ease forwards;}

/* ── MOBILE ── */
@media(max-width:540px){
  #bip{width:100vw!important;border-radius:0 0 8px 8px;border-left:none;border-right:none;border-top:none;}
  #bip-resize{display:none;}
  .color-grid{grid-template-columns:repeat(2,1fr);}
  .rep-row2{grid-template-columns:1fr;}
}
    `);
  }

  /* ═══════════════════════════════════════════════════════════
     APPLY CSS VARS
  ═══════════════════════════════════════════════════════════ */

  function applyVars() {
    const r = UI.root; if (!r) return;
    const t = S.theme;
    const s = r.style;
    s.setProperty('--a',   t.accent);
    s.setProperty('--dim', t.dim);
    s.setProperty('--bg',  t.bg);
    s.setProperty('--sf',  t.surface);
    s.setProperty('--ra',  t.raised);
    s.setProperty('--bd',  t.border);
    s.setProperty('--bd2', t.border2);
    s.setProperty('--tx',  t.text);
    s.setProperty('--sub', t.sub);
    s.setProperty('--dn',  t.danger);
    s.setProperty('--ok',  t.ok);
    s.setProperty('--wn',  t.warn);
    s.setProperty('--wp',  t.wpUrl ? `url("${t.wpUrl.replace(/"/g,'%22')}")` : 'none');
    s.setProperty('--wo',  t.wpOp);
    s.setProperty('--wb',  t.wpBr);
    // also push vars into modal (outside #bip)
    if (UI.ruleModal) {
      const ms = UI.ruleModal.style;
      ms.setProperty('--a',  t.accent); ms.setProperty('--bg', t.bg);
      ms.setProperty('--sf', t.surface); ms.setProperty('--bd2', t.border2);
      ms.setProperty('--bd', t.border); ms.setProperty('--tx', t.text);
      ms.setProperty('--sub', t.sub);
    }
  }

  function applySize() {
    const r = UI.root; if (!r) return;
    r.style.setProperty('--bw', parseInt(S.theme.width||520) + 'px');
    r.style.setProperty('--bh', parseInt(S.theme.height||680) + 'px');
  }

  function applyPos() {
    const r = UI.root; if (!r) return;
    r.style.transform = `translate3d(${S.pos.x}px,${S.pos.y}px,0)`;
  }

  /* ═══════════════════════════════════════════════════════════
     STATE UPDATES
  ═══════════════════════════════════════════════════════════ */

  function addReq(req) {
    S.reqs.unshift({
      id      : req.id || Math.random().toString(36).slice(2,9),
      type    : req.type || '?',
      method  : String(req.method||'GET').toUpperCase(),
      url     : fmtUrl(req.url||''),
      reqH    : req.requestHeaders  || {},
      reqB    : req.requestPayload  ?? null,
      resH    : req.responseHeaders || {},
      resB    : req.responsePayload ?? null,
      status  : req.status  ?? null,
      stxt    : req.statusText || '',
      ts      : req.timestamp || new Date().toISOString(),
      patched : req.patched  || false,
    });
    if (S.reqs.length > MAX_REQ) S.reqs.length = MAX_REQ; // limita memória
    saveHistory();
    if (S.ready) { renderList(); updateBadge(); }
  }

  function hide(r) {
    if (!r?.url) return true;
    if (S.ignored.has(r.url)||S.blocked.has(r.url)) return true;
    if (S.filterGet && r.method==='GET' && Number(r.status)>=200 && Number(r.status)<300) return true;
    return false;
  }

  function visible() { return S.reqs.filter(r=>!hide(r)); }

  function updateBadge() {
    const n = visible().length;
    if (UI.badge) UI.badge.textContent = String(n);
    if (UI.orbN)  UI.orbN.textContent  = String(n);
    if (UI.tabCounts) {
      const sends = visible().filter(isSend).length;
      const recvs = visible().filter(r=>!isSend(r)).length;
      if (UI.tabCounts.send) UI.tabCounts.send.textContent = String(sends);
      if (UI.tabCounts.recv) UI.tabCounts.recv.textContent = String(recvs);
    }
  }

  function isSend(r) {
    return r.method !== 'GET' || (r.reqB && String(r.reqB).trim() !== '');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPT RULES UI
  ═══════════════════════════════════════════════════════════ */

  function renderRules() {
    const body  = document.getElementById('rules-body-inner');
    const badge = document.getElementById('rules-badge');
    if (!body) return;

    const active = S.rules.filter(r => r.enabled).length;
    if (badge) badge.textContent = active ? `${active} active` : `${S.rules.length} rule${S.rules.length !== 1 ? 's' : ''}`;

    if (S.rules.length === 0) {
      body.innerHTML = '<div class="rules-empty">Nenhuma condição — adicione uma para começar a interceptar.</div>';
      return;
    }

    body.innerHTML = '';
    S.rules.forEach((rule, idx) => {
      const modeTag = rule.mode === 'var' ? '{}' : 'Aa';
      const flags = [
        rule.applyGet  ? 'GET'  : null,
        rule.applyPost ? 'POST' : null,
        (rule.mode === 'var' && rule.deepSearch) ? 'DEEP' : null,
      ].filter(Boolean).join(' · ');

      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML = `
        <div class="rule-texts">
          <div class="rule-find" title="${esc(rule.find)}">
            <span style="opacity:.5;font-size:8px;margin-right:4px;">${esc(modeTag)}</span>${esc(rule.find.length > 34 ? rule.find.slice(0,32)+'…' : rule.find)}
          </div>
          <div class="rule-replace" title="${esc(rule.replace)}">→ ${esc(rule.replace.length > 32 ? rule.replace.slice(0,30)+'…' : rule.replace)}</div>
          ${flags ? `<div style="font-size:8px;color:var(--sub);margin-top:1px;">${esc(flags)}</div>` : ''}
        </div>
        <label class="rule-tog" title="${rule.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''}>
          <span class="rule-tog-sl"></span>
        </label>
        <button class="rule-btn edit-btn" title="Edit"><img src="${IC.edit}" alt=""></button>
        <button class="rule-btn del-btn"  title="Delete"><img src="${IC.del}"  alt=""></button>
      `;
      row.querySelector('input[type=checkbox]').addEventListener('change', e => {
        S.rules[idx].enabled = e.target.checked;
        saveRules(); pushRulesToPage(); renderRules();
      });
      row.querySelector('.edit-btn').addEventListener('click', () => openRuleModal(idx));
      row.querySelector('.del-btn').addEventListener('click', () => {
        if (!confirm('Deletar esta condição?')) return;
        S.rules.splice(idx, 1);
        saveRules(); pushRulesToPage(); renderRules();
      });
      body.appendChild(row);
    });
  }

  function openRuleModal(editIdx) {
    const bg    = UI.ruleModalBg;
    const modal = UI.ruleModal;
    if (!bg || !modal) return;

    const isEdit = typeof editIdx === 'number';
    const rule   = isEdit ? S.rules[editIdx] : { find:'', replace:'', enabled:true, mode:'case', applyGet:true, applyPost:true, deepSearch:false };

    modal.querySelector('.rm-title').textContent      = isEdit ? 'Edit Condition' : 'New Condition';
    modal.querySelector('#rm-find').value             = rule.find;
    modal.querySelector('#rm-replace').value          = rule.replace;
    modal.querySelector('#rm-get').checked            = rule.applyGet  !== false;
    modal.querySelector('#rm-post').checked           = rule.applyPost !== false;
    modal.querySelector('#rm-deep').checked           = !!rule.deepSearch;
    modal.querySelector('#rm-save').textContent       = isEdit ? '✓  Save' : '✓  Add';
    modal.dataset.editIdx = isEdit ? String(editIdx) : '';

    // Setar modo
    const mode = rule.mode || 'case';
    modal.querySelectorAll('.rm-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    updateModalForMode(modal, mode);

    applyVars();
    bg.classList.add('on');
    modal.querySelector('#rm-find').focus();
  }

  function updateModalForMode(modal, mode) {
    const isVar = mode === 'var';
    modal.querySelector('#rm-find-label').textContent    = isVar ? 'Nome da variável (chave JSON)' : 'Find (texto exato)';
    modal.querySelector('#rm-replace-label').textContent = isVar ? 'Novo valor' : 'Replace with';
    modal.querySelector('#rm-find').placeholder          = isVar ? 'success' : '"success": false';
    modal.querySelector('#rm-replace').placeholder       = isVar ? 'true' : '"success": true';
    const deepWrap = modal.querySelector('#rm-deep-wrap');
    if (deepWrap) deepWrap.classList.toggle('disabled', !isVar);
  }

  function closeRuleModal() {
    UI.ruleModalBg?.classList.remove('on');
  }

  function saveRuleFromModal() {
    const modal   = UI.ruleModal;
    const find    = modal.querySelector('#rm-find').value.trim();
    const replace = modal.querySelector('#rm-replace').value;
    const mode    = modal.querySelector('.rm-mode-btn.active')?.dataset.mode || 'case';
    const applyGet  = modal.querySelector('#rm-get').checked;
    const applyPost = modal.querySelector('#rm-post').checked;
    const deepSearch = modal.querySelector('#rm-deep').checked;

    if (!find) { toast('Campo Find não pode ser vazio', 'err'); return; }

    const editIdx = modal.dataset.editIdx;
    const newRule = { find, replace, mode, applyGet, applyPost, deepSearch, enabled: true };

    if (editIdx !== '') {
      newRule.enabled = S.rules[parseInt(editIdx)].enabled;
      S.rules[parseInt(editIdx)] = newRule;
    } else {
      S.rules.push(newRule);
    }
    saveRules();
    pushRulesToPage();
    renderRules();
    closeRuleModal();
    toast(editIdx !== '' ? 'Condição atualizada' : 'Condição adicionada', 'ok');
  }

  /* ═══════════════════════════════════════════════════════════
     INTERCEPT RULES UI (segurar/bloquear request e response)
  ═══════════════════════════════════════════════════════════ */

  function syncIcpMaster() {
    const cb = document.getElementById('icp-on');
    if (cb) cb.checked = !!S.icpOn;
    const st = document.getElementById('icp-state');
    if (st) { st.textContent = S.icpOn ? 'on' : 'off'; st.style.color = S.icpOn ? 'var(--ok)' : 'var(--sub)'; }
    const hr = document.getElementById('icp-hold-req');
    if (hr) hr.checked = !!S.icpHoldReq;
    const hs = document.getElementById('icp-hold-res');
    if (hs) hs.checked = !!S.icpHoldRes;
  }

  function renderIcpRules() {
    const box = document.getElementById('icp-rules');
    if (!box) return;
    syncIcpMaster();
    box.innerHTML = '';
    if (!S.icp.length) {
      box.innerHTML = '<div class="rules-empty">Nenhuma regra. Adicione uma para bloquear URLs automaticamente.</div>';
      return;
    }
    S.icp.forEach((rule, idx) => {
      const phase = rule.phase === 'response' ? 'RESPONSE' : 'REQUEST';
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.innerHTML = `
        <div class="rule-texts">
          <div class="rule-find" title="${esc(rule.url||'')}">${esc(rule.url || '(todas as URLs)')}</div>
          <div class="rule-replace">${esc(rule.method||'ANY')} · ${phase} · Bloquear</div>
        </div>
        <label class="rule-tog" title="${rule.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''}>
          <span class="rule-tog-sl"></span>
        </label>
        <button class="rule-btn edit-btn" title="Edit"><img src="${IC.edit}" alt=""></button>
        <button class="rule-btn del-btn"  title="Delete"><img src="${IC.del}"  alt=""></button>
      `;
      row.querySelector('input[type=checkbox]').addEventListener('change', e => {
        S.icp[idx].enabled = e.target.checked;
        saveIcp(); pushRulesToPage(); renderIcpRules();
      });
      row.querySelector('.edit-btn').addEventListener('click', () => openIcpModal(idx));
      row.querySelector('.del-btn').addEventListener('click', () => {
        if (!confirm('Deletar esta regra de bloqueio?')) return;
        S.icp.splice(idx, 1);
        saveIcp(); pushRulesToPage(); renderIcpRules();
      });
      box.appendChild(row);
    });
  }

  function openIcpModal(editIdx) {
    const bg = UI.icpModalBg, modal = UI.icpModal;
    if (!bg || !modal) return;
    const isEdit = typeof editIdx === 'number';
    const rule = isEdit ? S.icp[editIdx] : { url:'', method:'ANY', phase:'request', enabled:true };

    modal.querySelector('#icp-modal-title').textContent = isEdit ? 'Editar regra de bloqueio' : 'Nova regra de bloqueio';
    modal.querySelector('#icp-url').value    = rule.url || '';
    modal.querySelector('#icp-method').value = rule.method || 'ANY';
    modal.querySelector('#icp-phase').value  = rule.phase || 'request';
    modal.querySelector('#icp-save').textContent = isEdit ? '✓  Save' : '✓  Add';
    modal.dataset.editIdx = isEdit ? String(editIdx) : '';

    applyVars();
    bg.classList.add('on');
    modal.querySelector('#icp-url').focus();
  }

  function closeIcpModal() { UI.icpModalBg?.classList.remove('on'); }

  function saveIcpFromModal() {
    const modal = UI.icpModal;
    const url    = modal.querySelector('#icp-url').value.trim();
    const method = modal.querySelector('#icp-method').value;
    const phase  = modal.querySelector('#icp-phase').value;

    const editIdx = modal.dataset.editIdx;
    const newRule = { url, method, phase, enabled: true };
    if (editIdx !== '') {
      newRule.enabled = S.icp[parseInt(editIdx)].enabled;
      S.icp[parseInt(editIdx)] = newRule;
    } else {
      S.icp.push(newRule);
    }
    saveIcp();
    pushRulesToPage();
    renderIcpRules();
    closeIcpModal();
    toast(editIdx !== '' ? 'Regra atualizada' : 'Regra adicionada', 'ok');
  }

  /* ═══════════════════════════════════════════════════════════
     HELD QUEUE (interceptação: segurar → editar → soltar/bloquear)
  ═══════════════════════════════════════════════════════════ */

  // Envia a decisão para o page world. `dec` pode trazer edições:
  //   { drop:true }                    → descarta
  //   { drop:false }                   → solta sem alterações
  //   { drop:false, req:{...} }        → solta o request EDITADO
  //   { drop:false, resBody:'...' }    → solta a response com corpo EDITADO
  function decideHeld(h, dec) {
    if (dec === true || dec === false) dec = { drop: dec }; // compat: decideHeld(h, true)
    dec = dec || {};
    const msg = { __BIP_DECISION__: true, bridge: BRIDGE, id: h.id, drop: !!dec.drop };
    if (dec.req) msg.req = dec.req;
    if (dec.resBody != null) msg.resBody = dec.resBody;
    try { window.postMessage(msg, ORIGIN); } catch {}
    const i = S.held.indexOf(h);
    if (i >= 0) S.held.splice(i, 1);
    if (S.icpEdit === h) { S.icpEdit = null; UI.icpOv?.classList.remove('on'); }
    renderHeld();
    toast(dec.drop ? 'Bloqueado' : 'Solto', dec.drop ? 'err' : 'ok');
  }

  // Solta (forward) tudo que está na fila — "fluir tudo".
  function flowAllHeld() {
    const items = S.held.slice();
    if (!items.length) return;
    items.forEach(h => decideHeld(h, { drop: false }));
  }

  // Solta (forward) tudo que está visível na sub-aba atual (Send ou Get).
  function flowVisibleHeld() {
    heldVisible().slice().forEach(h => decideHeld(h, { drop: false }));
  }

  function heldVisible() {
    const onlySend = S.heldView === 'send';
    return S.held.filter(h => (h.method !== 'GET') === onlySend);
  }

  function setHeldView(v) {
    S.heldView = v;
    const root = UI.root;
    if (root) {
      root.querySelectorAll('#pg-icp .icp-tab').forEach(b => b.classList.toggle('on', b.dataset.icpv === v));
    }
    renderHeld();
  }

  function renderHeld() {
    const badge = document.getElementById('icp-badge');
    if (badge) badge.textContent = S.held.length ? String(S.held.length) : '';

    // contadores das sub-abas
    const sendN = S.held.filter(h => h.method !== 'GET').length;
    const getN  = S.held.filter(h => h.method === 'GET').length;
    const cSend = document.getElementById('icp-tc-send');
    const cGet  = document.getElementById('icp-tc-get');
    if (cSend) cSend.textContent = sendN ? String(sendN) : '';
    if (cGet)  cGet.textContent  = getN  ? String(getN)  : '';

    const box = document.getElementById('icp-held');
    if (!box) return;
    box.innerHTML = '';
    const list = heldVisible();
    if (!list.length) {
      box.innerHTML = '<div class="rules-empty">Nada segurado aqui. Com a interceptação ligada, cada request fica nesta fila aguardando você editar e soltar (ou bloquear).</div>';
      return;
    }
    list.forEach(h => {
      const row = document.createElement('div');
      row.className = 'held-row';
      row.innerHTML = `
        <div class="held-top">
          <span class="held-phase ${h.phase==='response'?'is-res':'is-req'}">${h.phase==='response'?'RECEBENDO':'ENVIANDO'}</span>
          <span class="ri-method">${esc(h.method)}</span>
          <span class="held-url" title="${esc(h.url)}">${esc(shortUrl(h.url))}</span>
        </div>
        <div class="held-acts">
          <button class="abtn abtn-send held-flow">▶ Soltar</button>
          <button class="abtn abtn-clr held-drop">✕ Bloquear</button>
          <button class="abtn abtn-back held-edit">✎ Editar</button>
        </div>`;
      row.querySelector('.held-flow').addEventListener('click', () => decideHeld(h, { drop: false }));
      row.querySelector('.held-drop').addEventListener('click', () => decideHeld(h, { drop: true }));
      row.querySelector('.held-edit').addEventListener('click', () => openIcpEditor(h));
      box.appendChild(row);
    });
  }

  /* ── Editor do item segurado ── */
  function openIcpEditor(h) {
    const ov = UI.icpOv; if (!ov) return;
    S.icpEdit = h;
    ov.querySelector('.ov-title').textContent = shortUrl(h.url);
    const isRes = h.phase === 'response';
    ov.querySelector('#ie-phase').textContent = isRes ? 'RESPONSE (recebendo)' : 'REQUEST (enviando)';
    ov.querySelector('#ie-phase').className = 'ie-phase ' + (isRes ? 'is-res' : 'is-req');
    ov.querySelector('#ie-meta').innerHTML =
      `<span class="k">Method</span><span class="v">${esc(h.method)}</span>` +
      `<span class="k">URL</span><span class="v url-val">${esc(h.url)}</span>` +
      (isRes ? `<span class="k">Status</span><span class="v ${scls(h.status)}">${esc(String(h.status??''))} ${esc(h.stxt||'')}</span>` : '');

    // Campos editáveis conforme a fase
    ov.querySelector('#ie-req-fields').style.display = isRes ? 'none' : 'flex';
    ov.querySelector('#ie-res-fields').style.display = isRes ? 'flex' : 'none';

    if (!isRes) {
      ov.querySelector('#ie-method').value  = h.method || 'GET';
      ov.querySelector('#ie-url').value     = h.url || '';
      ov.querySelector('#ie-headers').value = JSON.stringify(h.reqH || {}, null, 2);
      ov.querySelector('#ie-body').value    = typeof h.reqB === 'string' ? h.reqB : (h.reqB == null ? '' : JSON.stringify(h.reqB));
    } else {
      ov.querySelector('#ie-rbody').value = typeof h.resB === 'string' ? h.resB : (h.resB == null ? '' : String(h.resB));
    }

    UI.detOv?.classList.remove('on');
    UI.repOv?.classList.remove('on');
    ov.classList.add('on');
  }

  function closeIcpEditor() { S.icpEdit = null; UI.icpOv?.classList.remove('on'); }

  // Solta o item em edição aplicando os campos editados.
  function flowIcpEditor() {
    const h = S.icpEdit; if (!h) return;
    const ov = UI.icpOv;
    if (h.phase === 'response') {
      const body = ov.querySelector('#ie-rbody').value;
      decideHeld(h, { drop: false, resBody: body });
      return;
    }
    let headers = {};
    try { headers = JSON.parse(ov.querySelector('#ie-headers').value || '{}'); }
    catch { toast('Headers JSON inválido', 'err'); return; }
    const req = {
      method : (ov.querySelector('#ie-method').value || h.method || 'GET').toUpperCase(),
      url    : ov.querySelector('#ie-url').value.trim() || h.url,
      headers,
      body   : ov.querySelector('#ie-body').value,
    };
    decideHeld(h, { drop: false, req });
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER LIST
  ═══════════════════════════════════════════════════════════ */

  function renderList() {
    const all   = visible();
    const sends = all.filter(isSend);
    const recvs = all.filter(r => !isSend(r));

    renderPage(UI.pageSend, sends, IC.send,  'No outgoing requests yet.\nMake a POST/PUT/PATCH to see them here.');
    renderPage(UI.pageRecv, recvs, IC.recv,  'No GET requests yet.\nBrowse around to capture traffic.');
    renderPip(all.slice(0, 12));
    updateBadge();
  }

  function renderPage(page, list, icon, emptyMsg) {
    if (!page) return;
    // preserve rules panel on recv page
    const rulesPanel = page.querySelector('#rules-panel');
    page.innerHTML = '';
    if (rulesPanel) page.appendChild(rulesPanel);

    if (list.length === 0) {
      const em = document.createElement('div');
      em.className = 'empty-state';
      em.innerHTML = `<img src="${icon}" alt=""><p>${esc(emptyMsg)}</p>`;
      page.appendChild(em);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'req-list';
    list.forEach(r => wrap.appendChild(makeRow(r)));
    page.appendChild(wrap);
  }

  function makeRow(r) {
    const div = document.createElement('div');
    const sc  = scls(r.status);
    const mc  = r.method === 'POST' ? 'is-post' : r.method === 'DELETE' ? 'is-del' : r.method === 'PUT' ? 'is-put' : '';
    const stc = Number(r.status)>=500?'is-5xx':Number(r.status)>=400?'is-4xx':'';
    const ptc = r.patched ? 'rule-hit' : '';
    div.className = `req-item ${mc} ${stc} ${ptc}`.trim();
    const typeLabel = r.patched ? r.type + ' ★' : r.type;
    div.innerHTML = `
      <div class="ri-strip"></div>
      <div class="ri-inner">
        <span class="ri-method">${esc(r.method)}</span>
        <span class="ri-url">${esc(shortUrl(r.url))}</span>
        <span class="ri-right">
          <span class="ri-status ${sc}">${esc(String(r.status??'…'))}</span>
          <span class="ri-type">${esc(typeLabel)}</span>
          <span class="ri-time">${relTime(r.ts)}</span>
        </span>
      </div>`;
    div.addEventListener('click', () => showDetail(r));
    return div;
  }

  function renderPip(list) {
    const c = UI.pipList; if (!c) return;
    c.innerHTML = '';
    if (!list.length) {
      c.innerHTML = '<div class="pip-row"><span class="pu">No requests</span></div>';
      return;
    }
    list.forEach(r => {
      const d = document.createElement('div');
      d.className = 'pip-row';
      d.innerHTML = `<span class="pm">${esc(r.method)}</span><span class="pu">${esc(shortUrl(r.url))}</span><span class="ps ${scls(r.status)}">${esc(String(r.status??'…'))}</span>`;
      d.addEventListener('click', () => { setMin(0); setTimeout(() => showDetail(r), 80); });
      c.appendChild(d);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     DETAIL
  ═══════════════════════════════════════════════════════════ */

  async function showDetail(r) {
    S.cur = r;
    S.panel = 'detail';
    const ov = UI.detOv; if (!ov) return;
    ov.querySelector('.ov-title').textContent = shortUrl(r.url);

    const ds = ov.querySelector('.det-scroll');
    ds.innerHTML = '<div style="color:var(--sub);font-size:10px;padding:16px;">Loading…</div>';
    ov.classList.add('on');
    UI.repOv?.classList.remove('on');

    const [rb, rsb] = await Promise.all([
      bodyText(r.reqB, getHdr(r.reqH, 'content-type')),
      bodyText(r.resB, getHdr(r.resH, 'content-type')),
    ]);

    const patchBadge = r.patched ? '<span class="rule-applied-badge">★ PATCHED</span>' : '';

    ds.innerHTML = `
      <div class="det-meta">
        <span class="k">URL</span><span class="v url-val">${esc(r.url)}</span>
        <span class="k">Method</span><span class="v">${esc(r.method)}</span>
        <span class="k">Status</span><span class="v ${scls(r.status)}">${esc(String(r.status??''))} ${esc(r.stxt||'')}</span>
        <span class="k">Type</span><span class="v">${esc(r.type)}</span>
        <span class="k">Time</span><span class="v">${new Date(r.ts).toLocaleString()}</span>
      </div>
      <div class="sec-label">Request Headers</div>
      <pre class="code-block">${esc(JSON.stringify(r.reqH||{},null,2))}</pre>
      <div class="sec-label">Request Body</div>
      <pre class="code-block">${esc(rb)}</pre>
      <div class="sec-label">Response Headers</div>
      <pre class="code-block">${esc(JSON.stringify(r.resH||{},null,2))}</pre>
      <div class="sec-label">Response Body ${patchBadge}</div>
      <pre class="code-block">${esc(rsb)}</pre>
    `;
  }

  /* ═══════════════════════════════════════════════════════════
     REPEATER
  ═══════════════════════════════════════════════════════════ */

  function openRep(r) {
    if (!r) return;
    S.panel = 'rep';
    UI.detOv?.classList.remove('on');
    const ov = UI.repOv; if (!ov) return;
    ov.classList.add('on');
    ov.querySelector('#rp-method').value  = r.method||'GET';
    ov.querySelector('#rp-url').value     = r.url||'';
    ov.querySelector('#rp-headers').value = JSON.stringify(r.reqH||{},null,2);
    ov.querySelector('#rp-body').value    = typeof r.reqB==='string' ? r.reqB : JSON.stringify(r.reqB??'',null,2);
    updatePreview();
  }

  function updatePreview() {
    const ov = UI.repOv; if (!ov) return;
    const method  = ov.querySelector('#rp-method')?.value||'';
    const url     = ov.querySelector('#rp-url')?.value||'';
    const headers = ov.querySelector('#rp-headers')?.value||'{}';
    const body    = ov.querySelector('#rp-body')?.value||'';
    const box     = ov.querySelector('#rp-prev');
    if (box) box.textContent = `${method} ${url}\n\nHeaders:\n${headers}\n\nBody:\n${body||'[empty]'}`;
  }

  async function doSend(method, url, hdrs, body) {
    const req = {
      id:Math.random().toString(36).slice(2,9)+'-R',
      type:'Repeater', method:String(method||'GET').toUpperCase(),
      url:fmtUrl(url), reqH:hdrs||{}, reqB:body??null,
      resH:{}, resB:null, status:null, stxt:'', ts:new Date().toISOString(),
    };
    try {
      const h = {...hdrs};
      let b = body;
      const ct = getHdr(h,'content-type');
      if (typeof b==='string' && b.trim()) {
        const p = tryJson(b.trim());
        if (p) { b=JSON.stringify(p); if(!ct) h['Content-Type']='application/json'; }
        else if (!ct) h['Content-Type']='text/plain';
      }
      const res = await fetch(req.url,{method:req.method,headers:h,body:(req.method==='GET'||req.method==='HEAD')?undefined:b,credentials:'include'});
      const cl  = res.clone();
      req.status=res.status; req.stxt=res.statusText;
      res.headers.forEach((v,k)=>req.resH[k.toLowerCase()]=v);
      req.resB = await bodyText(await cl.text(), req.resH['content-type']);
      addReq({...req, requestHeaders:req.reqH, requestPayload:req.reqB, responseHeaders:req.resH, responsePayload:req.resB});
      toast(`${res.status} ${res.statusText}`, Number(res.status)<400?'ok':'err');
    } catch(e) {
      req.status='ERR'; req.stxt=e?.message||String(e);
      addReq({...req, requestHeaders:req.reqH, requestPayload:req.reqB, responseHeaders:{}, responsePayload:null});
      toast('Error: ' + req.stxt, 'err');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MIN STATE
  ═══════════════════════════════════════════════════════════ */

  function setMin(n) {
    S.minState = n;
    saveMinState();
    const r = UI.root, o = UI.orb;
    if (!r||!o) return;

    if (n === 0) {
      o.classList.remove('on');
      r.style.display = 'flex';
      r.classList.remove('pip');
      return;
    }
    if (n === 1) {
      o.classList.remove('on');
      r.style.display = 'flex';
      r.classList.add('pip');
      renderPip(visible().slice(0,12));
      return;
    }
    // orb
    r.style.opacity = '0';
    setTimeout(() => {
      r.style.display = 'none';
      r.style.opacity = '';
      r.classList.remove('pip');
      o.classList.add('on');
    }, 140);
  }

  /* ═══════════════════════════════════════════════════════════
     PAGE HOOKS
  ═══════════════════════════════════════════════════════════ */

  function injectHooks() {
    const code = function(BRIDGE, ORIGIN) {
      // Regras/lista de bloqueio vivem aqui, atualizadas via mensagem do TM
      let __rules   = [];
      let __blocked = [];
      let __icp     = [];   // regras de BLOQUEIO automático (drop)
      let __icpOn   = false;
      let __holdReq = true; // segurar envio quando ligado
      let __holdRes = true; // segurar recepção quando ligado
      // Só a frame principal intercepta (segurar/bloquear); subframes apenas capturam.
      const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();
      const __pending = new Map();

      window.addEventListener('message', e => {
        if (ORIGIN !== '*' && e.origin && e.origin !== ORIGIN) return;
        if (e.data && e.data.__BIP_RULES__ && e.data.bridge === BRIDGE) {
          __rules   = e.data.rules   || [];
          __blocked = e.data.blocked || [];
          __icp     = e.data.icp     || [];
          __icpOn   = !!e.data.icpOn;
          __holdReq = e.data.holdReq !== false;
          __holdRes = e.data.holdRes !== false;
        }
      });

      // Decisão do usuário (Forward/Drop) vinda da UI no sandbox do TM
      window.addEventListener('message', e => {
        const d = e.data;
        if (d && d.__BIP_DECISION__ && d.bridge === BRIDGE && d.id != null) {
          const cb = __pending.get(d.id);
          if (cb) cb(d);
        }
      });

      // Regras = BLOQUEIO automático. Retorna a regra que casa (para descartar a
      // requisição/resposta), ou null.
      function matchBlock(url, method, phase) {
        if (!__icpOn || !__icp.length || !IS_TOP) return null;
        const u = abs(url);
        const M = (method || 'GET').toUpperCase();
        for (const r of __icp) {
          if (!r) continue;
          if (r.phase && r.phase !== phase) continue;
          if (r.method && r.method !== 'ANY' && r.method !== M) continue;
          if (r.url && u.indexOf(r.url) === -1) continue;
          return r;
        }
        return null;
      }
      // Segurar tudo (sem regra): só quando a interceptação está ligada e o
      // "segurar" daquela fase está ativo.
      function shouldHold(phase) {
        if (!__icpOn || !IS_TOP) return false;
        return phase === 'response' ? __holdRes : __holdReq;
      }
      function waitDecision(id) {
        return new Promise(resolve => { __pending.set(id, d => { __pending.delete(id); resolve(d); }); });
      }

      function post(p){try{window.postMessage({__BIP__:true,bridge:BRIDGE,payload:p}, ORIGIN);}catch(e){}}
      function h2o(h){const o={};try{if(!h)return o;if(h instanceof Headers){h.forEach((v,k)=>o[k.toLowerCase()]=v);return o;}if(Array.isArray(h)){h.forEach(([k,v])=>o[String(k).toLowerCase()]=String(v));return o;}if(typeof h==='object')Object.keys(h).forEach(k=>o[k.toLowerCase()]=String(h[k]));}catch(e){}return o;}
      async function b2t(b){try{if(b==null)return null;if(typeof b==='string')return b;if(b instanceof URLSearchParams)return b.toString();if(b instanceof FormData){const o={};for(const[k,v]of b.entries())o[k]=v instanceof File?'[File:'+v.name+']':v;return JSON.stringify(o);}if(b instanceof Blob)return await b.text();if(b instanceof Request){try{return await b.clone().text();}catch(e){return'[body n/a]';}}if(b instanceof ArrayBuffer)return'[AB:'+b.byteLength+'B]';if(ArrayBuffer.isView(b))return'[TA:'+b.byteLength+'B]';if(typeof b==='object')return JSON.stringify(b);return String(b);}catch(e){return'[err]';}}

      function abs(u){ try { return new URL(u, location.href).href; } catch(e) { return String(u||''); } }
      function isBlocked(u){ try { return __blocked.indexOf(abs(u)) !== -1; } catch(e) { return false; } }
      function rulesActiveFor(method){
        const isGet = method === 'GET';
        return __rules.some(r => r.enabled && (isGet ? r.applyGet : r.applyPost));
      }

      // Aplica regras no texto — chamado ANTES de devolver ao frontend
      function applyRules(text, method) {
        if (!text || !__rules.length) return text;
        let out = text;
        const isGet  = method === 'GET';
        const isPost = method !== 'GET';
        for (const rule of __rules) {
          if (!rule.enabled) continue;
          // Checar se o método bate
          if (isGet  && !rule.applyGet)  continue;
          if (isPost && !rule.applyPost) continue;

          if (rule.mode === 'var') {
            // Modo variável: substitui o VALOR da chave JSON, sem tocar no resto
            out = applyVarRule(out, rule.find, rule.replace, rule.deepSearch);
          } else {
            // Modo case (texto literal)
            out = out.split(rule.find).join(rule.replace);
          }
        }
        return out;
      }

      // Substitui valor de uma chave JSON independente de case/formatação
      function applyVarRule(text, key, newVal, deep) {
        try {
          const obj = JSON.parse(text);
          const changed = replaceKey(obj, key, newVal, deep);
          return changed ? JSON.stringify(obj) : text;
        } catch {
          // fallback: regex pra JSON não parseável ou parcial
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // match "key": <qualquer valor>
          const re = new RegExp('("' + escaped + '"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|\\[.*?\\]|\\{.*?\\})', 'g');
          return text.replace(re, (_, prefix) => prefix + JSON.stringify(newVal));
        }
      }

      function replaceKey(obj, key, newVal, deep, found = { v: false }) {
        if (obj === null || typeof obj !== 'object') return found.v;
        if (Array.isArray(obj)) {
          for (const item of obj) replaceKey(item, key, newVal, deep, found);
          return found.v;
        }
        for (const k of Object.keys(obj)) {
          if (k === key) {
            // tenta preservar tipo
            const orig = obj[k];
            if (typeof orig === 'number')  obj[k] = Number(newVal);
            else if (typeof orig === 'boolean') obj[k] = newVal === 'true' || newVal === true;
            else obj[k] = newVal;
            found.v = true;
            if (!deep) return found.v;
          }
          if (deep && obj[k] !== null && typeof obj[k] === 'object') {
            replaceKey(obj[k], key, newVal, deep, found);
          }
        }
        return found.v;
      }

      // ── Corpo: só tratamos conteúdo textual; binário/stream passa direto ──
      const MAX_BODY = 512 * 1024;
      const TEXT_CT  = /(json|text|xml|javascript|urlencoded|graphql|html|xhtml|css|yaml|csv)/i;
      function isTextual(ct){ return !ct || TEXT_CT.test(ct); }
      function isStream(ct){ return /event-stream/i.test(ct||''); }

      // Lê até MAX_BODY bytes sem bloquear a página (fire-and-forget)
      async function readCapped(res) {
        try {
          const reader = res.body && res.body.getReader ? res.body.getReader() : null;
          if (!reader) return await res.text();
          const chunks = []; let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); size += value.byteLength;
            if (size >= MAX_BODY) { try { reader.cancel(); } catch(e){} break; }
          }
          const buf = new Uint8Array(size);
          let off = 0;
          for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
          return new TextDecoder('utf-8', { fatal: false }).decode(buf);
        } catch(e) { return null; }
      }

      // ── Fetch ──
      const oF = window.fetch;
      window.fetch = async function(input, init){
        const id = Math.random().toString(36).slice(2,9);
        let url='', method='GET', rh={}, rb=null;
        try{
          if(input instanceof Request){url=input.url;method=(input.method||'GET').toUpperCase();rh=h2o(input.headers);try{rb=await b2t(input.clone());}catch(e){}if(init?.headers)rh=Object.assign({},rh,h2o(init.headers));if(init&&'body'in init)rb=await b2t(init.body);}
          else{url=typeof input==='string'?input:(input?.url||String(input));method=((init?.method)||'GET').toUpperCase();rh=h2o(init?.headers);rb=await b2t(init?.body);}
        }catch(e){}

        if (isBlocked(url)) {
          post({kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:{},responsePayload:null,status:'ERR',statusText:'Blocked',timestamp:new Date().toISOString(),patched:false,blocked:true});
          throw new TypeError('Failed to fetch');
        }

        // ── Bloqueio automático de REQUEST (regra) ──
        const blkReq = matchBlock(url, method, 'request');
        if (blkReq) {
          post({kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:{},responsePayload:null,status:'ERR',statusText:'Dropped',timestamp:new Date().toISOString(),patched:false,blocked:true});
          throw new TypeError('Failed to fetch');
        }

        // ── Segurar REQUEST (quando ligado): pausa antes de enviar e permite editar ──
        let edited = null;
        if (shouldHold('request')) {
          post({kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:{},responsePayload:null,status:null,statusText:'',timestamp:new Date().toISOString(),patched:false,held:true,phase:'request'});
          const dec = await waitDecision(id);
          if (dec.drop) {
            post({kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:{},responsePayload:null,status:'ERR',statusText:'Dropped',timestamp:new Date().toISOString(),patched:false,blocked:true});
            throw new TypeError('Failed to fetch');
          }
          if (dec.req) edited = dec.req; // usuário editou no editor antes de soltar
        }

        let res;
        try {
          if (edited) {
            // Reconstrói a chamada com os valores editados, preservando o resto do init.
            const init2 = (init && typeof init === 'object') ? { ...init } : {};
            if (input instanceof Request && !init) {
              // sem init: preserva credenciais/modo do Request original
              for (const k of ['credentials','mode','cache','redirect','referrer','referrerPolicy','integrity','keepalive']) {
                if (input[k] != null) init2[k] = input[k];
              }
            }
            if (edited.url)    url    = edited.url;
            if (edited.method) method = String(edited.method).toUpperCase();
            if (edited.headers) rh    = edited.headers;
            if ('body' in edited) rb  = edited.body;
            init2.method = method;
            init2.headers = rh;
            if (method === 'GET' || method === 'HEAD') delete init2.body;
            else init2.body = rb;
            res = await oF.call(this, url, init2);
          } else {
            res = await oF.apply(this, arguments); // sem edição: preserva init original
          }
        } catch(err) {
          post({kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:{},responsePayload:null,status:'ERR',statusText:err?.message||String(err),timestamp:new Date().toISOString(),patched:false});
          throw err;
        }

        const resH = {};
        try { res.headers.forEach((v,k)=>resH[k.toLowerCase()]=v); } catch(e){}
        const ct = resH['content-type'] || '';
        const ts = new Date().toISOString();
        const textual = isTextual(ct);
        const stream  = isStream(ct);
        const meta = {kind:'fetch',id,method,url:abs(url),requestHeaders:rh,requestPayload:rb,responseHeaders:resH,status:res.status,statusText:res.statusText,timestamp:ts};

        // ── Bloqueio automático de RESPONSE (regra) ──
        const blkRes = matchBlock(url, method, 'response');
        if (blkRes) {
          let rBody = null;
          if (textual && !stream) { try { rBody = await res.clone().text(); } catch(e) {} }
          post({...meta, responsePayload:rBody, status:'ERR', statusText:'Dropped', blocked:true});
          return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
        }

        // ── Segurar RESPONSE (quando ligado): pausa antes de devolver e permite editar ──
        if (shouldHold('response')) {
          let rBody = null;
          if (textual && !stream) { try { rBody = await res.clone().text(); } catch(e) { rBody = null; } }
          post({...meta, held:true, phase:'response', responsePayload:rBody});
          const dec = await waitDecision(id);
          if (dec.drop) {
            post({...meta, responsePayload:rBody, status:'ERR', statusText:'Dropped', blocked:true});
            return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
          }
          if (dec.resBody != null && textual && !stream) { // corpo editado antes de soltar
            post({...meta, responsePayload:dec.resBody, patched: dec.resBody !== rBody});
            return new Response(dec.resBody, { status: res.status, statusText: res.statusText, headers: res.headers });
          }
          // Forward sem edição: ainda aplica as regras de substituição, se houver.
          if (textual && !stream && rBody != null && rulesActiveFor(method)) {
            try {
              const patchedText = applyRules(rBody, method);
              post({...meta, responsePayload:patchedText, patched: patchedText !== rBody});
              if (patchedText !== rBody) return new Response(patchedText, { status: res.status, statusText: res.statusText, headers: res.headers });
            } catch(e) {}
          }
          post({...meta, responsePayload:rBody, patched:false});
          return res;
        }

        // Bufferiza/patcheia SOMENTE quando há regra aplicável, corpo textual e não é stream.
        if (textual && !stream && rulesActiveFor(method)) {
          try {
            const rawText     = await res.clone().text();
            const patchedText = applyRules(rawText, method);
            const wasPatched  = patchedText !== rawText;
            post({...meta, responsePayload:patchedText, patched:wasPatched});
            if (!wasPatched) return res;
            return new Response(patchedText, { status: res.status, statusText: res.statusText, headers: res.headers });
          } catch(e) { /* cai para o caminho não-bloqueante */ }
        }

        // Caminho padrão: devolve a resposta JÁ e captura o corpo em background (nunca trava).
        post({...meta, responsePayload:null, patched:false});
        if (textual && !stream) {
          const cloned = (() => { try { return res.clone(); } catch(e) { return null; } })();
          if (cloned) readCapped(cloned).then(text => {
            if (text != null) post({...meta, responsePayload:text, patched:false, update:true});
          }).catch(()=>{});
        }
        return res;
      };

      // ── XHR ──
      const XHR = window.XMLHttpRequest;
      const oO  = XHR.prototype.open, oSd = XHR.prototype.send, oSH = XHR.prototype.setRequestHeader;
      const protoText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
      const protoResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

      XHR.prototype.open = function(m,u){ this.__b={id:Math.random().toString(36).slice(2,9),method:(m||'GET').toUpperCase(),url:u,requestHeaders:{},requestPayload:null}; return oO.apply(this,arguments); };
      XHR.prototype.setRequestHeader = function(k,v){ if(this.__b) this.__b.requestHeaders[k.toLowerCase()]=String(v); return oSH.apply(this,arguments); };

      // Patch no nível do protótipo: garante valor correto mesmo se o site ler em
      // onreadystatechange (antes dos nossos listeners). Só para responseType textual.
      function patchedTextFor(x) {
        const raw = protoText && protoText.get ? protoText.get.call(x) : '';
        if (typeof raw !== 'string') return raw;
        const m = (x.__b && x.__b.method) || 'GET';
        if (!rulesActiveFor(m)) return raw;
        if (x.__patchedRaw === raw) return x.__patchedText;
        try { x.__patchedText = applyRules(raw, m); } catch(e) { x.__patchedText = raw; }
        x.__patchedRaw = raw;
        return x.__patchedText;
      }
      Object.defineProperty(XHR.prototype, 'responseText', {
        configurable: true,
        get() {
          try {
            if (this.readyState !== 4) return protoText.get.call(this);
            return patchedTextFor(this);
          } catch(e) { return protoText.get.call(this); }
        },
      });
      Object.defineProperty(XHR.prototype, 'response', {
        configurable: true,
        get() {
          try {
            const rt = this.responseType;
            if ((rt === '' || rt === 'text') && this.readyState === 4) return patchedTextFor(this);
          } catch(e) {}
          return protoResp.get.call(this);
        },
      });

      XHR.prototype.send = function(body){
        if(this.__b) this.__b.requestPayload = body;
        const x = this;
        const args = arguments;
        const id = (x.__b && x.__b.id) || '';
        const origMethod = (x.__b && x.__b.method) || 'GET';
        const url = (x.__b && x.__b.url) || '';
        let emitted = false;

        const base = () => ({kind:'xhr',id,method:origMethod,url:abs(url),requestHeaders:(x.__b&&x.__b.requestHeaders)||{},requestPayload:(x.__b&&x.__b.requestPayload)??null});
        function resHeaders(){
          const o = {};
          try { (x.getAllResponseHeaders?.()||'').split(/\r?\n/).forEach(l=>{const i=l.indexOf(':');if(i>-1){const k=l.slice(0,i).trim().toLowerCase();if(k)o[k]=l.slice(i+1).trim();}}); } catch(e){}
          return o;
        }
        function resBody(){
          try {
            const rt = x.responseType;
            if (rt === '' || rt === 'text') return typeof x.responseText === 'string' ? x.responseText : null;
            if (rt === 'json')              return x.response != null ? JSON.stringify(x.response, null, 2) : null;
            if (rt === 'arraybuffer')       return x.response ? '[ArrayBuffer ' + x.response.byteLength + 'B]' : null;
            if (rt === 'blob')              return x.response ? '[Blob ' + x.response.size + 'B]' : null;
            if (rt === 'document')          return '[Document]';
          } catch(e) {}
          return null;
        }
        function emit(phase, extra){
          if (emitted) return; emitted = true;
          try {
            const rt = x.responseType;
            const patched = (rt === '' || rt === 'text') && x.__patchedText != null && x.__patchedText !== x.__patchedRaw;
            post({...base(), phase, responseHeaders:resHeaders(), responsePayload:resBody(),
              status: phase==='error' ? 'ERR' : x.status,
              statusText: phase==='error' ? 'Net Error' : (x.statusText||''),
              timestamp:new Date().toISOString(), patched, ...(extra||{})});
          } catch(e){}
        }
        function dropNow(){
          emit('error', {status:'ERR', statusText:'Dropped', blocked:true});
          setTimeout(()=>{ try { x.abort(); } catch(e){} }, 0);
        }

        if (isBlocked(url)) {
          emit('error', {status:'ERR', statusText:'Blocked', blocked:true});
          setTimeout(()=>{ try { x.abort(); } catch(e){} }, 0);
          return;
        }

        const blkReq = matchBlock(url, origMethod, 'request');
        const blkRes = matchBlock(url, origMethod, 'response');

        // ── Bloqueio automático de REQUEST (regra) ──
        if (blkReq) { dropNow(); return; }

        // ── Bloqueio automático de RESPONSE (regra) ──
        if (blkRes) {
          x.addEventListener('load', () => dropNow(), { once:true });
          x.addEventListener('error', () => emit('error'), { once:true });
          x.addEventListener('abort', () => emit('error'), { once:true });
          return oSd.apply(this, args);
        }

        const holdReq = shouldHold('request');
        const holdRes = shouldHold('response');

        // ── RESPONSE segurada: adia o emit até a decisão (permite editar) ──
        if (holdRes) {
          x.addEventListener('load', () => {
            post({...base(), held:true, phase:'response', responseHeaders:resHeaders(), responsePayload:resBody(), status:x.status, statusText:x.statusText||'', timestamp:new Date().toISOString()});
            waitDecision(id).then(dec => { if (dec.drop) dropNow(); else emit('done', dec.resBody != null ? { responsePayload: dec.resBody, patched:true } : null); });
          }, { once:true });
          x.addEventListener('error', () => emit('error'), { once:true });
          x.addEventListener('abort', () => emit('error'), { once:true });
          if (!holdReq) return oSd.apply(this, args);
        } else {
          x.addEventListener('load',  () => emit('done'));
          x.addEventListener('error', () => emit('error'));
          x.addEventListener('abort', () => emit('error'));
        }

        // ── REQUEST segurada: pausa o envio até a decisão (permite editar) ──
        if (holdReq) {
          post({...base(), held:true, phase:'request', status:null, statusText:'', timestamp:new Date().toISOString()});
          waitDecision(id).then(dec => {
            if (dec.drop) { dropNow(); return; }
            if (dec.req) { // edição: aplica no objeto antes de enviar
              try {
                if (dec.req.headers) {
                  x.__b.requestHeaders = dec.req.headers;
                  for (const k in dec.req.headers) { try { oSH.call(x, k, dec.req.headers[k]); } catch(e) {} }
                }
                if ('body' in dec.req) { x.__b.requestPayload = dec.req.body; args[0] = dec.req.body; }
                if (dec.req.method && x.__b) x.__b.method = String(dec.req.method).toUpperCase();
                if (dec.req.url) { x.__b.url = dec.req.url; try { oO.call(x, x.__b.method, dec.req.url); } catch(e) {} }
              } catch(e) {}
            }
            try { oSd.apply(x, args); } catch(e) {}
          });
          return;
        }

        return oSd.apply(this, args);
      };
    };

    const s = document.createElement('script');
    s.textContent = '(' + code.toString() + ')(' + JSON.stringify(BRIDGE) + ',' + JSON.stringify(ORIGIN) + ');';
    (document.documentElement||document.head||document.body).appendChild(s);
    s.remove();
  }

  function setupMsg() {
    window.addEventListener('message', e => {
      const d = e.data;
      if (!d||d.__BIP__!==true||d.bridge!==BRIDGE) return;
      const p = d.payload||{};
      if (p.kind!=='fetch'&&p.kind!=='xhr') return;

      // Subframes não têm UI: repassam a captura para a frame principal.
      if (!IS_TOP) {
        if (!d.fwd) {
          try { window.top.postMessage({ __BIP__:true, bridge:BRIDGE, fwd:true, payload:p }, '*'); } catch (_) {}
        }
        return;
      }

      // Request segurado (hold) aguardando decisão Forward/Drop
      if (p.held) {
        const h = {
          id:p.id, phase:p.phase||'request', type:p.kind==='fetch'?'Fetch':'XHR',
          method:String(p.method||'GET').toUpperCase(), url:fmtUrl(p.url||''),
          reqH:p.requestHeaders||{}, reqB:p.requestPayload??null,
          resH:p.responseHeaders||{}, resB:p.responsePayload??null,
          status:p.status??null, stxt:p.statusText||'',
          ts:p.timestamp||new Date().toISOString(),
        };
        const i = S.held.findIndex(x => x.id === h.id && x.phase === h.phase);
        if (i >= 0) S.held[i] = h; else S.held.unshift(h);
        renderHeld();
        return;
      }

      // Atualização tardia (corpo capturado em background): mescla no item existente
      if (p.update) {
        const r = S.reqs.find(x => x.id === p.id);
        if (r) {
          r.resB = p.responsePayload ?? r.resB;
          saveHistory();
          if (S.cur === r && UI.detOv?.classList.contains('on')) showDetail(r);
        }
        return;
      }

      addReq({
        id:p.id, type:p.kind==='fetch'?'Fetch':'XHR',
        method:p.method, url:p.url,
        requestHeaders:p.requestHeaders||{},
        requestPayload:p.requestPayload??null,
        responseHeaders:p.responseHeaders||{},
        responsePayload:p.responsePayload??null,
        status:p.status, statusText:p.statusText||'',
        timestamp:p.timestamp||new Date().toISOString(),
        patched:p.patched||false,
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BUILD UI
  ═══════════════════════════════════════════════════════════ */

  function buildUI() {
    if (S.ready) return;
    S.ready = true;

    injectCSS();

    /* ── Root ── */
    const root = document.createElement('div');
    root.id = 'bip';
    root.classList.add('entering');
    setTimeout(() => root.classList.remove('entering'), 200);

    root.innerHTML = `
<!-- HEADER -->
<div id="bip-hdr">
  <img class="hdr-logo" src="${IC.logo}" alt="">
  <span class="hdr-title">BurpImpure</span>
  <span class="hdr-badge" id="bip-badge">0</span>
  <span class="hdr-sep"></span>
  <button class="hbtn pip-btn"   id="btn-min"   title="PiP — dblclick for orb"><img src="${IC.pkg}"   alt="">PiP</button>
  <button class="hbtn orb-btn"   id="btn-orb"   title="Minimize to orb" style="margin-left:6px;"><img src="${IC.block}" alt="">Orb</button>
  <button class="hbtn close-btn" id="btn-close" title="Close" style="margin-left:6px;"><img src="${IC.del}"   alt="">Close</button>
</div>

<!-- TABS -->
<div id="bip-tabs">
  <button class="tab on" data-tab="send"><img src="${IC.send}" alt="">Send<span class="tab-count" id="tc-send">0</span></button>
  <button class="tab"    data-tab="recv"><img src="${IC.recv}" alt="">Receive<span class="tab-count" id="tc-recv">0</span></button>
  <button class="tab"    data-tab="icp" ><img src="${IC.block}" alt="">Intercept<span class="tab-count" id="icp-badge"></span></button>
  <button class="tab"    data-tab="cfg" ><img src="${IC.edit}" alt="">Config</button>
</div>

<!-- BODY -->
<div id="bip-body">

  <!-- Send page -->
  <div class="page on" id="pg-send"></div>

  <!-- Recv page — rules panel injected here by JS -->
  <div class="page" id="pg-recv"></div>

  <!-- Intercept page -->
  <div class="page" id="pg-icp">
    <div class="icp-body">
      <div class="icp-head">
        <label class="tog icp-master" title="Ligar/desligar toda a interceptação">
          <input type="checkbox" id="icp-on"><span class="tog-sl"></span>
        </label>
        <span class="icp-head-lbl">Interceptação <span id="icp-state">off</span></span>
        <button class="abtn abtn-send" id="icp-flow-all" style="margin-left:auto;" title="Soltar todos os requests da fila">▶ Fluir tudo</button>
      </div>

      <div class="icp-holds">
        <label class="icp-hold-opt" title="Segurar cada request antes de enviar">
          <input type="checkbox" id="icp-hold-req"><span>Segurar envio</span>
        </label>
        <label class="icp-hold-opt" title="Segurar cada resposta antes de devolver ao site">
          <input type="checkbox" id="icp-hold-res"><span>Segurar recepção</span>
        </label>
      </div>

      <div class="icp-tabs">
        <button class="icp-tab on" data-icpv="send">Send<span class="tab-count" id="icp-tc-send"></span></button>
        <button class="icp-tab"    data-icpv="get" >Get<span class="tab-count" id="icp-tc-get"></span></button>
        <button class="abtn abtn-send" id="icp-flow-vis" style="margin-left:auto;padding:3px 8px;font-size:9px;" title="Soltar os itens desta aba">▶ Fluir esta aba</button>
      </div>

      <div id="icp-held"></div>

      <div class="sec-label" style="padding:0 10px;">Bloqueio automático (regras)</div>
      <div class="icp-head" style="border-top:1px solid var(--bd);border-bottom:none;padding-top:6px;padding-bottom:0;">
        <span class="icp-head-lbl" style="color:var(--sub);font-weight:400;text-transform:none;letter-spacing:0;">Bloqueia sozinho, sem você decidir</span>
        <button class="abtn abtn-send" id="icp-add" style="margin-left:auto;">＋ Nova regra</button>
      </div>
      <div id="icp-rules"></div>
    </div>
  </div>

  <!-- Config page -->
  <div class="page" id="pg-cfg">
    <div class="cfg-body">

      <div class="cfg-section">
        <div class="cfg-heading">Filters</div>
        <div class="cfg-row">
          <label for="tog-get">Auto-hide clean GET responses</label>
          <label class="tog"><input type="checkbox" id="tog-get"><span class="tog-sl"></span></label>
        </div>
      </div>

      <div class="cfg-section">
        <div class="cfg-heading">History</div>
        <button class="abtn abtn-clr" id="btn-clr"><img src="${IC.del}" alt="">Clear All Requests</button>
      </div>

      <div class="cfg-section">
        <div class="cfg-heading">Window Size</div>
        <div class="size-label">Width: <span id="lw">520</span>px</div>
        <div class="range-row"><input type="range" id="sl-w" min="300" max="960" step="10"><span class="range-val" id="lw2">520</span></div>
        <div class="size-label" style="margin-top:8px;">Height: <span id="lh">680</span>px</div>
        <div class="range-row"><input type="range" id="sl-h" min="260" max="960" step="10"><span class="range-val" id="lh2">680</span></div>
      </div>

      <div class="cfg-section">
        <div class="cfg-heading">Colors</div>
        <div class="color-grid">
          <div class="c-item"><span class="c-label">Accent</span><input type="color" class="c-swatch" id="c-accent"></div>
          <div class="c-item"><span class="c-label">Accent Dim</span><input type="color" class="c-swatch" id="c-dim"></div>
          <div class="c-item"><span class="c-label">Background</span><input type="color" class="c-swatch" id="c-bg"></div>
          <div class="c-item"><span class="c-label">Surface</span><input type="color" class="c-swatch" id="c-sf"></div>
          <div class="c-item"><span class="c-label">Raised</span><input type="color" class="c-swatch" id="c-ra"></div>
          <div class="c-item"><span class="c-label">Border</span><input type="color" class="c-swatch" id="c-bd"></div>
          <div class="c-item"><span class="c-label">Border 2</span><input type="color" class="c-swatch" id="c-bd2"></div>
          <div class="c-item"><span class="c-label">Text</span><input type="color" class="c-swatch" id="c-tx"></div>
          <div class="c-item"><span class="c-label">Muted</span><input type="color" class="c-swatch" id="c-sub"></div>
        </div>
        <button class="abtn abtn-rst" id="btn-rst" style="margin-top:6px;"><img src="${IC.del}" alt="">Reset Defaults</button>
      </div>

      <div class="cfg-section">
        <div class="cfg-heading">Wallpaper</div>
        <div class="fgroup" style="margin-bottom:8px;">
          <div class="flabel">Image URL</div>
          <input class="finput" type="text" id="c-wp" placeholder="https://example.com/bg.jpg">
        </div>
        <div class="size-label">Opacity: <span id="l-op">0.10</span></div>
        <div class="range-row"><input type="range" id="sl-op" min="0" max="1" step="0.01"><span class="range-val" id="l-op2">0.10</span></div>
        <div class="size-label" style="margin-top:6px;">Brightness: <span id="l-br">1.00</span></div>
        <div class="range-row"><input type="range" id="sl-br" min="0.2" max="2" step="0.01"><span class="range-val" id="l-br2">1.00</span></div>
      </div>

    </div>
  </div>

  <!-- Detail overlay -->
  <div class="overlay" id="ov-det">
    <div class="ov-hdr">
      <button class="abtn abtn-back" id="det-bk"><img src="${IC.block}" alt="">Back</button>
      <span class="ov-title">Request Detail</span>
    </div>
    <div class="det-scroll"></div>
    <div class="act-bar">
      <button class="abtn abtn-rep"  id="det-rep"><img src="${IC.edit}"  alt="">Repeater</button>
      <button class="abtn abtn-copy" id="det-cpy"><img src="${IC.send}"  alt="">Copy URL</button>
      <button class="abtn abtn-ign"  id="det-ign"><img src="${IC.block}" alt="">Ignore</button>
      <button class="abtn abtn-blk"  id="det-blk"><img src="${IC.del}"   alt="">Block</button>
    </div>
  </div>

  <!-- Repeater overlay -->
  <div class="overlay" id="ov-rep">
    <div class="ov-hdr">
      <button class="abtn abtn-back" id="rep-bk"><img src="${IC.block}" alt="">Back</button>
      <span class="ov-title">Repeater</span>
    </div>
    <div class="rep-body">
      <div class="rep-row2">
        <div class="fgroup">
          <div class="flabel">Method</div>
          <input class="finput" type="text" id="rp-method" placeholder="GET">
        </div>
        <div class="fgroup">
          <div class="flabel">URL</div>
          <input class="finput" type="text" id="rp-url" placeholder="https://…">
        </div>
      </div>
      <div class="fgroup">
        <div class="flabel">Headers (JSON)</div>
        <textarea class="ftextarea" id="rp-headers" placeholder='{"Content-Type":"application/json"}'></textarea>
      </div>
      <div class="fgroup">
        <div class="flabel">Body</div>
        <textarea class="ftextarea tall" id="rp-body" placeholder="Request body…"></textarea>
      </div>
      <div class="fgroup">
        <div class="flabel">Live Preview</div>
        <div class="prev-box" id="rp-prev"></div>
      </div>
    </div>
    <div class="act-bar">
      <button class="abtn abtn-send" id="rep-send"><img src="${IC.send}" alt="">Send Request</button>
    </div>
  </div>

  <!-- Intercept editor overlay -->
  <div class="overlay" id="ov-icp">
    <div class="ov-hdr">
      <button class="abtn abtn-back" id="ie-bk"><img src="${IC.block}" alt="">Voltar</button>
      <span class="ov-title">Editar interceptado</span>
      <span class="ie-phase is-req" id="ie-phase">REQUEST</span>
    </div>
    <div class="rep-body">
      <div class="det-meta ie-meta" id="ie-meta"></div>

      <div id="ie-req-fields" style="display:flex;flex-direction:column;gap:10px;">
        <div class="rep-row2">
          <div class="fgroup">
            <div class="flabel">Method</div>
            <input class="finput" type="text" id="ie-method" placeholder="GET">
          </div>
          <div class="fgroup">
            <div class="flabel">URL</div>
            <input class="finput" type="text" id="ie-url" placeholder="https://…">
          </div>
        </div>
        <div class="fgroup">
          <div class="flabel">Headers (JSON)</div>
          <textarea class="ftextarea" id="ie-headers" placeholder='{"Content-Type":"application/json"}'></textarea>
        </div>
        <div class="fgroup">
          <div class="flabel">Body</div>
          <textarea class="ftextarea tall" id="ie-body" placeholder="Request body…"></textarea>
        </div>
      </div>

      <div id="ie-res-fields" style="display:none;flex-direction:column;gap:10px;">
        <div class="fgroup">
          <div class="flabel">Response Body (edite antes de soltar)</div>
          <textarea class="ftextarea tall" id="ie-rbody" placeholder="Response body…"></textarea>
        </div>
      </div>
    </div>
    <div class="act-bar">
      <button class="abtn abtn-send" id="ie-flow"><img src="${IC.send}" alt="">Soltar (deixar ir)</button>
      <button class="abtn abtn-clr"  id="ie-drop"><img src="${IC.del}"  alt="">Bloquear</button>
    </div>
  </div>

</div><!-- /body -->

<!-- PiP list -->
<div id="bip-pip-list"></div>

<!-- resize handle -->
<div id="bip-resize"></div>
    `;

    /* ── Orb ── */
    const orb = document.createElement('div');
    orb.id = 'bip-orb';
    orb.innerHTML = `<img src="${IC.logo}" alt=""><span id="bip-orb-n">0</span>`;

    /* ── Rule Modal ── */
    const modalBg = document.createElement('div');
    modalBg.id = 'rule-modal-bg';
    modalBg.innerHTML = `
<div id="rule-modal">
  <div class="rm-hdr">
    <span class="rm-title">New Condition</span>
  </div>
  <div class="rm-body">

    <!-- Modo -->
    <div class="rm-mode-row">
      <button class="rm-mode-btn active" id="rm-mode-case" data-mode="case">
        <span class="rm-mode-icon">Aa</span>
        <span class="rm-mode-label">Text Replace</span>
        <span class="rm-mode-desc">Substitui texto literal na resposta</span>
      </button>
      <button class="rm-mode-btn" id="rm-mode-var" data-mode="var">
        <span class="rm-mode-icon">{}</span>
        <span class="rm-mode-label">Var Replace</span>
        <span class="rm-mode-desc">Substitui valor de uma chave JSON</span>
      </button>
    </div>

    <!-- Campos find/replace -->
    <div class="rm-row">
      <div class="rm-field">
        <div class="rm-label" id="rm-find-label">Find (texto exato)</div>
        <input class="finput" type="text" id="rm-find" placeholder='"success": false' autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="rm-row">
      <div class="rm-field">
        <div class="rm-label" id="rm-replace-label">Replace with</div>
        <input class="finput" type="text" id="rm-replace" placeholder='"success": true' autocomplete="off" spellcheck="false">
      </div>
    </div>

    <!-- Opções -->
    <div class="rm-opts-row">
      <label class="rm-opt-tog" title="Aplicar em respostas GET">
        <input type="checkbox" id="rm-get" checked>
        <span class="rm-opt-sl"></span>
        <span class="rm-opt-lbl">GET</span>
      </label>
      <label class="rm-opt-tog" title="Aplicar em respostas POST/PUT/PATCH/DELETE">
        <input type="checkbox" id="rm-post" checked>
        <span class="rm-opt-sl"></span>
        <span class="rm-opt-lbl">POST</span>
      </label>
      <label class="rm-opt-tog" id="rm-deep-wrap" title="Busca profunda: percorre objetos/arrays aninhados (modo Var)">
        <input type="checkbox" id="rm-deep">
        <span class="rm-opt-sl"></span>
        <span class="rm-opt-lbl">Deep Search</span>
      </label>
    </div>

  </div>
  <div class="rm-footer">
    <button class="abtn abtn-rst" id="rm-cancel">✕  Cancel</button>
    <button class="abtn abtn-save" id="rm-save">✓  Add</button>
  </div>
</div>
    `;

    // Anexa ao <html> (não ao <body>): sobrevive a sites que trocam/re-renderizam
    // o body inteiro, evitando que o painel "suma" ou fique atrás do site.
    const target = document.documentElement || document.body;
    target.appendChild(root);
    target.appendChild(orb);
    target.appendChild(modalBg);

    /* ── Intercept rule modal ── */
    const icpBg = document.createElement('div');
    icpBg.id = 'icp-modal-bg';
    icpBg.innerHTML = `
<div id="icp-modal">
  <div class="rm-hdr"><span class="rm-title" id="icp-modal-title">Nova regra de interceptação</span></div>
  <div class="rm-body">
    <div class="rm-row">
      <div class="rm-field">
        <div class="rm-label">URL contém (vazio = todas)</div>
        <input class="finput" type="text" id="icp-url" placeholder="/api/ (substring da URL)" autocomplete="off" spellcheck="false">
      </div>
    </div>
    <div class="rm-row2">
      <div class="rm-field">
        <div class="rm-label">Método</div>
        <select class="finput" id="icp-method">
          <option value="ANY">Qualquer</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>
      <div class="rm-field">
        <div class="rm-label">Fase</div>
        <select class="finput" id="icp-phase">
          <option value="request">Request (não enviar)</option>
          <option value="response">Response (não receber)</option>
        </select>
      </div>
    </div>
    <div class="rm-hint">A regra <b>bloqueia automaticamente</b> (não envia/não recebe). Para segurar e editar antes de deixar ir, use a interceptação ligada acima.</div>
  </div>
  <div class="rm-footer">
    <button class="abtn abtn-rst" id="icp-cancel">✕  Cancel</button>
    <button class="abtn abtn-save" id="icp-save">✓  Add</button>
  </div>
</div>`;
    target.appendChild(icpBg);

    UI.root       = root;
    UI.orb        = orb;
    UI.ruleModalBg = modalBg;
    UI.ruleModal   = modalBg.querySelector('#rule-modal');
    UI.icpModalBg  = icpBg;
    UI.icpModal    = icpBg.querySelector('#icp-modal');
    UI.pageIcp     = root.querySelector('#pg-icp');
    UI.icpOv       = root.querySelector('#ov-icp');
    UI.badge       = root.querySelector('#bip-badge');
    UI.orbN        = orb.querySelector('#bip-orb-n');
    UI.pageSend    = root.querySelector('#pg-send');
    UI.pageRecv    = root.querySelector('#pg-recv');
    UI.pageCfg     = root.querySelector('#pg-cfg');
    UI.detOv       = root.querySelector('#ov-det');
    UI.repOv       = root.querySelector('#ov-rep');
    UI.pipList     = root.querySelector('#bip-pip-list');
    UI.tabCounts   = { send: root.querySelector('#tc-send'), recv: root.querySelector('#tc-recv') };

    /* ── Inject rules panel into recv page ── */
    const rulesPanel = document.createElement('div');
    rulesPanel.id = 'rules-panel';
    rulesPanel.innerHTML = `
      <div class="rules-header" id="rules-toggle">
        <img class="rules-icon" src="${IC.edit}" alt="">
        <span class="rules-title">Intercept Rules</span>
        <span class="rules-badge" id="rules-badge">0 rules</span>
        <button class="rules-add-btn" id="rules-add-btn" title="Add condition">＋ Add Condition</button>
        <span class="rules-chevron" id="rules-chevron">›</span>
      </div>
      <div class="rules-body" id="rules-body">
        <div id="rules-body-inner"></div>
      </div>
    `;
    UI.pageRecv.appendChild(rulesPanel);

    applyVars();
    applySize();
    applyPos();
    syncCfgInputs();

    /* ══════════ DRAG — window ══════════ */
    const hdr = root.querySelector('#bip-hdr');
    let wd=false, wsx=0, wsy=0;

    function onHdrDown(e) {
      if (e.target.closest('button,.hdr-badge')) return;
      e.preventDefault();
      wd = true;
      wsx = e.clientX - S.pos.x;
      wsy = e.clientY - S.pos.y;
      root.style.touchAction = 'none';
      try { hdr.setPointerCapture(e.pointerId); } catch {}
    }
    function onWinMove(e) {
      if (!wd) return;
      e.preventDefault();
      S.pos.x = Math.max(-200, Math.min(window.innerWidth  - 100, e.clientX - wsx));
      S.pos.y = Math.max(0,    Math.min(window.innerHeight - 40,  e.clientY - wsy));
      root.style.transform = `translate3d(${S.pos.x}px,${S.pos.y}px,0)`;
    }
    function onWinUp() {
      if (wd) {
        wd = false;
        root.style.touchAction = '';
        savePos();
      }
    }

    hdr.addEventListener('pointerdown', onHdrDown, { passive: false });
    window.addEventListener('pointermove', onWinMove, { passive: false });
    window.addEventListener('pointerup',   onWinUp);

    /* ══════════ RESIZE ══════════ */
    const rh = root.querySelector('#bip-resize');
    let rd=false, rsx=0, rsy=0, rbw=0, rbh=0;
    rh.addEventListener('pointerdown', e => {
      rd=true;
      try { rh.setPointerCapture(e.pointerId); } catch {}
      rsx=e.clientX; rsy=e.clientY;
      rbw=parseInt(S.theme.width||520);
      rbh=parseInt(S.theme.height||680);
      e.preventDefault();
    });
    window.addEventListener('pointermove', e => {
      if (!rd) return;
      const nw = Math.max(300, Math.min(960, rbw+(e.clientX-rsx)));
      const nh = Math.max(260, Math.min(960, rbh+(e.clientY-rsy)));
      S.theme.width=String(nw); S.theme.height=String(nh);
      applySize();
      const sw=root.querySelector('#sl-w'),sh=root.querySelector('#sl-h');
      if(sw){sw.value=nw;root.querySelector('#lw').textContent=nw;root.querySelector('#lw2').textContent=nw;}
      if(sh){sh.value=nh;root.querySelector('#lh').textContent=nh;root.querySelector('#lh2').textContent=nh;}
    });
    window.addEventListener('pointerup', () => { if(rd){rd=false;saveTheme();} });

    /* ══════════ PiP / Orb buttons ══════════ */
    let minT = null;
    root.querySelector('#btn-min').addEventListener('click', () => {
      if (minT) return;
      minT = setTimeout(() => { minT=null; setMin(S.minState===0?1:0); }, 200);
    });
    root.querySelector('#btn-min').addEventListener('dblclick', () => { clearTimeout(minT); minT=null; setMin(2); });
    root.querySelector('#btn-orb').addEventListener('click', () => setMin(2));
    root.querySelector('#btn-close').addEventListener('click', () => {
      root.style.transition='opacity .14s'; root.style.opacity='0';
      setTimeout(()=>{root.remove();orb.remove();modalBg.remove();},150);
    });

    /* ══════════ TABS ══════════ */
    root.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.tab').forEach(b=>b.classList.remove('on'));
        btn.classList.add('on');
        root.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
        root.querySelector('#pg-'+btn.dataset.tab).classList.add('on');
        UI.detOv?.classList.remove('on');
        UI.repOv?.classList.remove('on');
        S.view = btn.dataset.tab;
      });
    });

    /* ══════════ ORB DRAG ══════════ */
    let od=false, om=false, osx=0, osy=0, obx=0, oby=0;
    orb.addEventListener('pointerdown', e => {
      e.preventDefault();
      od=true; om=false; osx=e.clientX; osy=e.clientY;
      obx=S.orbPos.x; oby=S.orbPos.y;
      try { orb.setPointerCapture(e.pointerId); } catch {}
    }, { passive: false });
    window.addEventListener('pointermove', e => {
      if (!od) return;
      e.preventDefault();
      const dx=e.clientX-osx, dy=e.clientY-osy;
      if (Math.abs(dx)>3||Math.abs(dy)>3) om=true;
      S.orbPos={
        x:Math.max(4,Math.min(window.innerWidth -52, obx+dx)),
        y:Math.max(4,Math.min(window.innerHeight-52, oby+dy)),
      };
      orb.style.left=S.orbPos.x+'px'; orb.style.top=S.orbPos.y+'px';
      orb.style.right='auto'; orb.style.bottom='auto';
    }, { passive: false });
    window.addEventListener('pointerup', () => {
      if (od) { if (!om) setMin(0); else saveOrbPos(); od=false; }
    });
    orb.style.left=S.orbPos.x+'px'; orb.style.top=S.orbPos.y+'px';
    orb.style.right='auto'; orb.style.bottom='auto';

    /* ══════════ DETAIL ACTIONS ══════════ */
    root.querySelector('#det-bk').addEventListener('click',  () => UI.detOv.classList.remove('on'));
    root.querySelector('#det-rep').addEventListener('click', () => { if(S.cur) openRep(S.cur); });
    root.querySelector('#det-cpy').addEventListener('click', async () => {
      if (!S.cur) return;
      try { await navigator.clipboard.writeText(S.cur.url); }
      catch { try { GM_setClipboard(S.cur.url); } catch {} }
      toast('URL copied!', 'ok');
    });
    root.querySelector('#det-ign').addEventListener('click', () => {
      if (!S.cur) return;
      S.ignored.add(S.cur.url);
      saveSet(IK, S.ignored);
      UI.detOv.classList.remove('on');
      renderList();
    });
    root.querySelector('#det-blk').addEventListener('click', () => {
      if (!S.cur) return;
      S.blocked.add(S.cur.url);
      saveSet(BK, S.blocked);
      pushRulesToPage(); // avisa o hook para abortar essa URL
      UI.detOv.classList.remove('on');
      renderList();
      toast('URL bloqueada', 'ok');
    });

    /* ══════════ REPEATER ══════════ */
    root.querySelector('#rep-bk').addEventListener('click', () => {
      UI.repOv.classList.remove('on');
      if (S.cur) UI.detOv.classList.add('on');
    });
    root.querySelector('#rep-send').addEventListener('click', async () => {
      const m=root.querySelector('#rp-method').value;
      const u=root.querySelector('#rp-url').value;
      const b=root.querySelector('#rp-body').value;
      let h={};
      try { h=JSON.parse(root.querySelector('#rp-headers').value||'{}'); }
      catch { toast('Invalid JSON in headers','err'); return; }
      UI.repOv.classList.remove('on');
      await doSend(m,u,h,b);
    });
    ['#rp-method','#rp-url','#rp-headers','#rp-body'].forEach(sel => {
      root.querySelector(sel)?.addEventListener('input', updatePreview);
    });

    /* ══════════ CONFIG ══════════ */
    root.querySelector('#tog-get').addEventListener('change', e => { S.filterGet=e.target.checked; renderList(); });
    root.querySelector('#btn-clr').addEventListener('click',  () => {
      if (!confirm('Clear all request history?')) return;
      S.reqs=[]; S.cur=null;
      persistHistoryNow(true); // lista vazia só é gravada com force (Clear explícito)
      UI.detOv.classList.remove('on');
      UI.repOv.classList.remove('on');
      renderList(); updateBadge();
    });
    root.querySelector('#btn-rst').addEventListener('click', () => {
      S.theme={...DT}; saveTheme(); applyVars(); applySize(); syncCfgInputs();
    });

    const cmap={'#c-accent':'accent','#c-dim':'dim','#c-bg':'bg','#c-sf':'surface','#c-ra':'raised','#c-bd':'border','#c-bd2':'border2','#c-tx':'text','#c-sub':'sub'};
    Object.entries(cmap).forEach(([sel,key]) => {
      root.querySelector(sel)?.addEventListener('input', e => { S.theme[key]=e.target.value; saveTheme(); applyVars(); });
    });
    root.querySelector('#c-wp')?.addEventListener('input', e => { S.theme.wpUrl=e.target.value.trim(); saveTheme(); applyVars(); });

    function bindRange(slId, lId, l2Id, themeKey, fmt=v=>v) {
      const sl=root.querySelector(slId), l=root.querySelector(lId), l2=root.querySelector(l2Id);
      if (!sl) return;
      sl.addEventListener('input', e => {
        const v=e.target.value;
        if(l) l.textContent=fmt(v); if(l2) l2.textContent=fmt(v);
        S.theme[themeKey]=v; saveTheme();
        if(themeKey==='width'||themeKey==='height') applySize();
        else applyVars();
      });
    }
    bindRange('#sl-w','#lw','#lw2','width');
    bindRange('#sl-h','#lh','#lh2','height');
    bindRange('#sl-op','#l-op','#l-op2','wpOp',v=>Number(v).toFixed(2));
    bindRange('#sl-br','#l-br','#l-br2','wpBr',v=>Number(v).toFixed(2));

    /* ══════════ RULES PANEL ══════════ */
    const rulesToggle  = rulesPanel.querySelector('#rules-toggle');
    const rulesChevron = rulesPanel.querySelector('#rules-chevron');
    const rulesBody    = rulesPanel.querySelector('#rules-body');
    const rulesAddBtn  = rulesPanel.querySelector('#rules-add-btn');

    rulesToggle.addEventListener('click', e => {
      if (e.target.closest('#rules-add-btn')) return;
      const open = rulesBody.classList.toggle('open');
      rulesChevron.classList.toggle('open', open);
    });

    rulesAddBtn.addEventListener('click', e => {
      e.stopPropagation();
      openRuleModal();
    });

    /* ══════════ RULE MODAL ══════════ */
    modalBg.querySelector('#rm-cancel').addEventListener('click', closeRuleModal);
    modalBg.querySelector('#rm-save').addEventListener('click', saveRuleFromModal);
    modalBg.querySelector('#rm-find').addEventListener('keydown', e => { if(e.key==='Enter') modalBg.querySelector('#rm-replace').focus(); });
    modalBg.querySelector('#rm-replace').addEventListener('keydown', e => { if(e.key==='Enter') saveRuleFromModal(); });
    modalBg.addEventListener('click', e => { if(e.target===modalBg) closeRuleModal(); });

    // Mode buttons (case / var)
    modalBg.querySelectorAll('.rm-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modalBg.querySelectorAll('.rm-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateModalForMode(UI.ruleModal, btn.dataset.mode);
      });
    });

    /* ══════════ INTERCEPT ══════════ */
    root.querySelector('#icp-on').addEventListener('change', e => {
      S.icpOn = e.target.checked;
      saveIcpOn();
      syncIcpMaster();
      // Ao desligar, libera tudo que estava segurado para não travar o site.
      if (!S.icpOn && S.held.length) {
        [...S.held].forEach(h => decideHeld(h, { drop: false }));
      }
      pushRulesToPage();
    });
    root.querySelector('#icp-hold-req').addEventListener('change', e => {
      S.icpHoldReq = e.target.checked; saveIcpHold('holdreq', S.icpHoldReq); pushRulesToPage();
    });
    root.querySelector('#icp-hold-res').addEventListener('change', e => {
      S.icpHoldRes = e.target.checked; saveIcpHold('holdres', S.icpHoldRes); pushRulesToPage();
    });
    root.querySelector('#icp-flow-all').addEventListener('click', flowAllHeld);
    root.querySelector('#icp-flow-vis').addEventListener('click', flowVisibleHeld);
    root.querySelectorAll('#pg-icp .icp-tab').forEach(b => {
      b.addEventListener('click', () => setHeldView(b.dataset.icpv));
    });
    root.querySelector('#icp-add').addEventListener('click', () => openIcpModal());

    // Editor do item segurado
    root.querySelector('#ie-bk').addEventListener('click', closeIcpEditor);
    root.querySelector('#ie-flow').addEventListener('click', flowIcpEditor);
    root.querySelector('#ie-drop').addEventListener('click', () => { const h = S.icpEdit; if (h) decideHeld(h, { drop: true }); });

    icpBg.querySelector('#icp-cancel').addEventListener('click', closeIcpModal);
    icpBg.querySelector('#icp-save').addEventListener('click', saveIcpFromModal);
    icpBg.addEventListener('click', e => { if (e.target === icpBg) closeIcpModal(); });
    icpBg.querySelector('#icp-url').addEventListener('keydown', e => { if (e.key === 'Enter') saveIcpFromModal(); });

    renderIcpRules();
    renderHeld();
    renderRules();
    renderList();
    updateBadge();

    // Restaurar estado de minimização da sessão anterior
    if (S.minState !== 0) {
      if (S.minState === 1) {
        root.classList.add('pip');
        renderPip(visible().slice(0, 12));
      } else if (S.minState === 2) {
        root.style.display = 'none';
        orb.classList.add('on');
      }
    }
  }

  /* ── Sync config inputs ── */
  function syncCfgInputs() {
    const r=UI.root; if(!r) return;
    const t=S.theme;
    const set=(id,v)=>{const el=r.querySelector(id);if(el)el.value=v;};
    const txt=(id,v)=>{const el=r.querySelector(id);if(el)el.textContent=v;};
    set('#c-accent',t.accent); set('#c-dim',t.dim);
    set('#c-bg',t.bg);         set('#c-sf',t.surface);
    set('#c-ra',t.raised);     set('#c-bd',t.border);
    set('#c-bd2',t.border2);   set('#c-tx',t.text);
    set('#c-sub',t.sub);       set('#c-wp',t.wpUrl||'');
    const op=Number(t.wpOp).toFixed(2);
    const br=Number(t.wpBr).toFixed(2);
    const w=parseInt(t.width||520);
    const h=parseInt(t.height||680);
    set('#sl-op',t.wpOp); txt('#l-op',op);  txt('#l-op2',op);
    set('#sl-br',t.wpBr); txt('#l-br',br);  txt('#l-br2',br);
    set('#sl-w',w);        txt('#lw',w);     txt('#lw2',w);
    set('#sl-h',h);        txt('#lh',h);     txt('#lh2',h);
  }

  /* ═══════════════════════════════════════════════════════════
     BOOT
  ═══════════════════════════════════════════════════════════ */

  function boot() {
    injectHooks();
    setupMsg();
    // Todos os frames entregam as regras ao próprio hook (GM storage é compartilhado).
    pushRulesToPage();
    // Garante a gravação do histórico antes da página sair (troca de site, fechar
    // aba/navegador). pagehide/visibilitychange são mais confiáveis que beforeunload.
    try {
      window.addEventListener('pagehide', flushHistory);
      window.addEventListener('beforeunload', flushHistory);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushHistory(); });
    } catch (_) {}
    // Somente a frame principal monta a UI (subframes só capturam e repassam).
    if (!IS_TOP) return;
    if (document.body || document.documentElement) buildUI();
    else window.addEventListener('DOMContentLoaded', buildUI, { once: true });
    watchUI();
  }

  // Alguns sites montam o conteúdo num stacking context próprio ou re-renderizam
  // o <body>, o que empurra o painel para baixo do visual do site. Aqui a UI é
  // anexada ao <html> e re-anexada se for removida ou ficar atrás de algum overlay.
  function watchUI() {
    let mo = null;
    try {
      mo = new MutationObserver(() => {
        if (!UI.root) return;
        // removida do DOM → re-anexa
        if (!UI.root.isConnected) reattachUI();
        else ensureTop();
      });
      mo.observe(document.documentElement, { childList: true });
      if (document.body) mo.observe(document.body, { childList: true });
    } catch (_) {}
    // rede de segurança periódica (layouts que reposicionam via JS/CSS)
    setInterval(() => { if (UI.root && !UI.root.isConnected) reattachUI(); else ensureTop(); }, 1500);
  }

  function reattachUI() {
    const host = document.documentElement;
    if (!host) return;
    [UI.root, UI.orb, UI.ruleModalBg, UI.icpModalBg].forEach(el => { if (el && !el.isConnected) host.appendChild(el); });
    ensureTop();
  }

  // Se algum elemento de overlay do site estiver pintando acima do painel,
  // eleva o z-index do painel acima dele.
  let __zBump = 2147483647;
  function ensureTop() {
    const r = UI.root; if (!r) return;
    let max = 0;
    try {
      const els = document.querySelectorAll('body *');
      const n = Math.min(els.length, 800);
      for (let i = 0; i < n; i++) {
        const z = parseInt(getComputedStyle(els[i]).zIndex, 10);
        if (z > max && els[i] !== r) max = z;
      }
    } catch (_) {}
    if (max >= __zBump) {
      __zBump = Math.min(2147483647, max + 1);
      r.style.setProperty('z-index', String(__zBump), 'important');
    }
  }

  boot();

})();

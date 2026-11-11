--[[
  BurpImpure (Lua) — Interceptor HTTP estilo Burp Suite para Roblox.
  Port fiel do userscript `user.js` (mesma arquitetura: capturar, regras de
  substituição, bloqueio automático, e interceptação segurar → editar → soltar).

  Executor: qualquer um que forneça `request`/`http_request`, hookfunction,
  setclipboard e writefile/readfile (Synapse, Script-Ware, Krnl, Fluxus, ...).
  Sem esses recursos o script ainda roda, só que sem persistência/hook.

  @version 7.8
  @author  Manus & Raro Sec
]]

-- ═══════════════════════════════════════════════════════════
-- COMPATIBILIDADE DE EXECUTOR
-- ═══════════════════════════════════════════════════════════

local genv = (type(getgenv) == 'function' and getgenv()) or _G

-- Função HTTP do executor (nome varia). Preferimos `request`/`http.request`.
local httpRequest =
  (type(syn) == 'table' and syn.request) or
  (type(http) == 'table' and http.request) or
  (type(request) == 'function' and request) or
  (type(http_request) == 'function' and http_request) or
  (type(fluxus) == 'table' and fluxus.request) or
  (type(krnl) == 'table' and krnl.request) or
  (type(game) == 'table' and game.HttpRequest) or nil

local hasRequest = httpRequest ~= nil

-- Clipboard
local setClipboard =
  (type(setclipboard) == 'function' and setclipboard) or
  (type(toclipboard) == 'function' and toclipboard) or nil

-- Hooking
local hookfunction = (type(hookfunction) == 'function' and hookfunction) or
  (type(replaceclosure) == 'function' and replaceclosure) or nil
local getrawmetatable = (type(getrawmetatable) == 'function' and getrawmetatable) or nil
local setreadonly = (type(setreadonly) == 'function' and setreadonly) or
  (type(make_writeable) == 'function' and make_writeable) or nil

-- Arquivos (persistência)
local writefile   = (type(writefile) == 'function' and writefile) or nil
local readfile    = (type(readfile) == 'function' and readfile) or nil
local isfile      = (type(isfile) == 'function' and isfile) or nil
local makefolder  = (type(makefolder) == 'function' and makefolder) or nil
local isfolder    = (type(isfolder) == 'function' and isfolder) or nil
local listfiles   = (type(listfiles) == 'function' and listfiles) or nil

-- Yield / tarefas (Roblox ou executor)
local spawn = (type(task) == 'table' and task.spawn) or (type(spawn) == 'function' and spawn) or nil
local waitFn = (type(task) == 'table' and task.wait) or (type(wait) == 'function' and wait) or nil
local delay = (type(task) == 'table' and task.delay) or (type(delay) == 'function' and delay) or nil

-- Serviços do Roblox
local UserInputService = game:GetService('UserInputService')
local HttpService = game:GetService('HttpService')
local RunService = game:GetService('RunService')
local CoreGui = (type(gethui) == 'function' and gethui()) or game:GetService('CoreGui')

-- Viewport (para layout responsivo). O painel tem tamanho fixo no userscript,
-- mas em celular 520x680 não cabe na tela — aqui derivamos do viewport.
local Workspace = game:GetService('Workspace')

local function currentCamera()
  return Workspace and Workspace.CurrentCamera
end

local function viewportSize()
  local cam = currentCamera()
  local vp = cam and cam.ViewportSize
  if vp and vp.X and vp.X > 0 and vp.Y and vp.Y > 0 then return vp.X, vp.Y end
  return 1280, 720
end

-- Margem de segurança nas bordas da tela.
local SCREEN_MARGIN = 12

-- Dimensões do painel principal: nunca maiores que a tela menos a margem.
local function rootDims()
  local vw, vh = viewportSize()
  local w = math.max(math.min(520, vw - SCREEN_MARGIN * 2), 260)
  local h = math.max(math.min(680, vh - SCREEN_MARGIN * 2), 220)
  return w, h
end

-- Mantém a posição dentro da tela (após trocar de orientação, por ex.).
local function clampPos(x, y, w, h)
  local vw, vh = viewportSize()
  x = math.max(0, math.min(x or SCREEN_MARGIN, vw - w))
  y = math.max(0, math.min(y or SCREEN_MARGIN, vh - h))
  return x, y
end

-- Layout adaptativo: telas estreitas (celular) usam fontes/paddings menores.
local function isCompact()
  local vw = viewportSize()
  return vw < 640
end

local function uiScale()
  local vw = viewportSize()
  if vw < 420 then return 0.85 end
  if vw < 640 then return 0.92 end
  return 1
end

local function fs(px) return math.max(9, math.floor(px * uiScale() + 0.5)) end

-- Altura padrão de botão: maior no mobile (alvo de toque confortável).
local function btnH() return isCompact() and 32 or 26 end

-- Referência à RequestAsync ORIGINAL, guardada antes de installHooks() trocá-la.
-- Sem isso, o fallback de doHttp() chamaria a versão já interceptada e entraria
-- em recursão infinita (perform → doHttp → RequestAsync → perform → …).
local originalRequestAsync
pcall(function() originalRequestAsync = HttpService.RequestAsync end)

-- ═══════════════════════════════════════════════════════════
-- JSON (encoder/decoder mínimo, sem dependências)
-- ═══════════════════════════════════════════════════════════

local JSON = {}

local ESC = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function encodeString(s)
  return '"' .. s:gsub('[%z\1-\31\\"]', function(c)
    local e = ESC[c]
    if e then return e end
    return string.format('\\u%04x', string.byte(c))
  end) .. '"'
end

local function encodeValue(v, out)
  local t = type(v)
  if v == nil then
    out[#out + 1] = 'null'
  elseif t == 'boolean' then
    out[#out + 1] = v and 'true' or 'false'
  elseif t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then
      out[#out + 1] = 'null'
    else
      out[#out + 1] = tostring(v)
    end
  elseif t == 'string' then
    out[#out + 1] = encodeString(v)
  elseif t == 'table' then
    local n = #v
    local count = 0
    for _ in pairs(v) do count = count + 1 end
    if n > 0 and count == n then
      out[#out + 1] = '['
      for i = 1, n do
        if i > 1 then out[#out + 1] = ',' end
        encodeValue(v[i], out)
      end
      out[#out + 1] = ']'
    else
      out[#out + 1] = '{'
      -- Chaves ordenadas: a tabela Lua não preserva ordem de inserção, então
      -- ordenamos para a saída ser determinística/estável.
      local keys = {}
      for k in pairs(v) do
        if type(k) == 'string' or type(k) == 'number' then keys[#keys + 1] = k end
      end
      table.sort(keys, function(a, b)
        if type(a) == type(b) then return a < b end
        return tostring(a) < tostring(b)
      end)
      for i, k in ipairs(keys) do
        if i > 1 then out[#out + 1] = ',' end
        out[#out + 1] = encodeString(tostring(k))
        out[#out + 1] = ':'
        encodeValue(v[k], out)
      end
      out[#out + 1] = '}'
    end
  else
    out[#out + 1] = 'null'
  end
end

function JSON.encode(v)
  local out = {}
  encodeValue(v, out)
  return table.concat(out)
end

local function decode(str)
  local pos = 1
  local len = #str
  local function skip()
    while pos <= len do
      local c = str:sub(pos, pos)
      if c == ' ' or c == '\n' or c == '\r' or c == '\t' then pos = pos + 1 else break end
    end
  end
  local parseValue
  local function parseString()
    pos = pos + 1
    local buf = {}
    while true do
      local c = str:sub(pos, pos)
      if c == '' then error('json: string sem fim') end
      if c == '"' then pos = pos + 1 break
      elseif c == '\\' then
        pos = pos + 1
        local e = str:sub(pos, pos)
        if e == 'n' then buf[#buf + 1] = '\n'
        elseif e == 't' then buf[#buf + 1] = '\t'
        elseif e == 'r' then buf[#buf + 1] = '\r'
        elseif e == 'b' then buf[#buf + 1] = '\b'
        elseif e == 'f' then buf[#buf + 1] = '\f'
        elseif e == '/' then buf[#buf + 1] = '/'
        elseif e == '\\' then buf[#buf + 1] = '\\'
        elseif e == '"' then buf[#buf + 1] = '"'
        elseif e == 'u' then
          local hex = str:sub(pos + 1, pos + 4)
          pos = pos + 4
          local code = tonumber(hex, 16) or 63
          if code < 0x80 then
            buf[#buf + 1] = string.char(code)
          elseif code < 0x800 then
            buf[#buf + 1] = string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
          else
            buf[#buf + 1] = string.char(0xE0 + math.floor(code / 0x1000),
              0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
          end
        else
          buf[#buf + 1] = e
        end
        pos = pos + 1
      else
        buf[#buf + 1] = c
        pos = pos + 1
      end
    end
    return table.concat(buf)
  end
  local function parseNumber()
    local start = pos
    while pos <= len and str:sub(pos, pos):match('[%d%.eE%+%-]') do pos = pos + 1 end
    return tonumber(str:sub(start, pos - 1))
  end
  parseValue = function()
    skip()
    local c = str:sub(pos, pos)
    if c == '{' then
      pos = pos + 1
      local obj = {}
      skip()
      if str:sub(pos, pos) == '}' then pos = pos + 1 return obj end
      while true do
        skip()
        local key = parseString()
        skip()
        pos = pos + 1 -- ':'
        obj[key] = parseValue()
        skip()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == '}' then break end
      end
      return obj
    elseif c == '[' then
      pos = pos + 1
      local arr = {}
      skip()
      if str:sub(pos, pos) == ']' then pos = pos + 1 return arr end
      while true do
        arr[#arr + 1] = parseValue()
        skip()
        local d = str:sub(pos, pos)
        pos = pos + 1
        if d == ']' then break end
      end
      return arr
    elseif c == '"' then
      return parseString()
    elseif c == 't' then pos = pos + 4 return true
    elseif c == 'f' then pos = pos + 5 return false
    elseif c == 'n' then pos = pos + 4 return nil
    else
      return parseNumber()
    end
  end
  skip()
  return parseValue()
end

function JSON.decode(str)
  if type(str) ~= 'string' or str == '' then return nil end
  local ok, res = pcall(decode, str)
  if ok then return res end
  return nil
end

-- ═══════════════════════════════════════════════════════════
-- CONSTANTES / TEMA
-- ═══════════════════════════════════════════════════════════

local SK = 'bip_theme_v7'
local OK = 'bip_orb_v7'
local PK = 'bip_pos_v7'
local RK = 'bip_rules_v7'
local MK = 'bip_min_v7'
local IK = 'bip_ign_v7'
local BK = 'bip_blk_v7'
local HK = 'bip_hist_v7'
local ICK = 'bip_icp_v7'

local MAX_REQ = 500
local PERSIST_MAX = 200
local PERSIST_BODY = 5000
local MAX_BODY = 512 * 1024

local DT = {
  accent = '#c8ff00', dim = '#7a9900', bg = '#080808', surface = '#0f0f0f',
  raised = '#161616', border = '#1e1e1e', border2 = '#2a2a2a', text = '#e2e2e2',
  sub = '#888888', danger = '#ff3d3d', warn = '#ffaa00', ok = '#22cc66',
}

-- Converte "#rrggbb" → Color3
local function hex(str, fallback)
  str = tostring(str or ''):gsub('#', '')
  local r = tonumber(str:sub(1, 2), 16)
  local g = tonumber(str:sub(3, 4), 16)
  local b = tonumber(str:sub(5, 6), 16)
  if not (r and g and b) then return fallback or Color3.fromRGB(255, 255, 255) end
  return Color3.fromRGB(r, g, b)
end

-- ═══════════════════════════════════════════════════════════
-- PERSISTÊNCIA (arquivos do executor; fallback: memória)
-- ═══════════════════════════════════════════════════════════

local FOLDER = 'BurpImpure'
if makefolder and isfolder and not isfolder(FOLDER) then
  pcall(makefolder, FOLDER)
end

local function filePath(k) return FOLDER .. '/' .. k .. '.json' end

local function fsGet(k, default)
  if not (readfile and isfile) then return default end
  local ok, ok2 = pcall(isfile, filePath(k))
  if not ok or not ok2 then return default end
  local rok, data = pcall(readfile, filePath(k))
  if not rok or not data then return default end
  local v = JSON.decode(data)
  if v == nil then return default end
  return v
end

local function fsSet(k, value)
  if not writefile then return end
  pcall(writefile, filePath(k), JSON.encode(value))
end

-- ═══════════════════════════════════════════════════════════
-- HELPERS
-- ═══════════════════════════════════════════════════════════

local function tryJson(t)
  if type(t) ~= 'string' then return nil end
  local ok, v = pcall(JSON.decode, t)
  if ok then return v end
  return nil
end

local function nowIso()
  if type(DateTime) == 'table' or type(DateTime) == 'function' then
    local ok, s = pcall(function() return DateTime.now():FormatLocalTime('YYYY-MM-DDTHH:mm:ss', 'en-us') end)
    if ok and s then return s end
  end
  return tostring(os.time())
end

local function nowMs()
  if type(tick) == 'function' then return tick() * 1000 end
  return os.time() * 1000
end

local function shortUrl(u)
  u = tostring(u or '')
  local host = u:match('^%a+://([^/]+)')
  local path = u:match('^%a+://[^/]+(/.*)$') or ''
  local s = (host or u) .. path
  if #s > 52 then s = s:sub(1, 50) .. '…' end
  return s
end

local function statusClass(s)
  local n = tonumber(s)
  if not n then return 'sx' end
  if n >= 500 then return 's5' end
  if n >= 400 then return 's4' end
  if n >= 300 then return 's3' end
  if n >= 200 then return 's2' end
  return 'sx'
end

local function relTime(ts)
  local t = tonumber(ts) or nowMs()
  local d = nowMs() - t
  if d < 1000 then return 'agora' end
  if d < 60000 then return math.floor(d / 1000) .. 's atrás' end
  if d < 3600000 then return math.floor(d / 60000) .. 'm atrás' end
  return os.date('%H:%M', math.floor(t / 1000))
end

local function getHdr(h, name)
  if type(h) ~= 'table' then return '' end
  local l = tostring(name):lower()
  for k, v in pairs(h) do
    if tostring(k):lower() == l then return tostring(v) end
  end
  return ''
end

local function isTextual(ct)
  if not ct or ct == '' then return true end
  return tostring(ct):lower():match('json') or tostring(ct):lower():match('text')
    or tostring(ct):lower():match('xml') or tostring(ct):lower():match('javascript')
    or tostring(ct):lower():match('urlencoded') or tostring(ct):lower():match('graphql')
    or tostring(ct):lower():match('html') or tostring(ct):lower():match('css')
    or tostring(ct):lower():match('csv') or tostring(ct):lower():match('yaml')
end

local function isStream(ct)
  return ct and tostring(ct):lower():match('event%-stream') ~= nil
end

-- ═══════════════════════════════════════════════════════════
-- MOTOR DE REGRAS (substituição de texto e de valor JSON)
-- ═══════════════════════════════════════════════════════════

local Rules = {}

-- Substitui o valor da chave JSON `key` por `newVal` (preserva tipo), recursivo
-- quando `deep`. Espelha replaceKey() do user.js.
local function replaceKey(obj, key, newVal, deep, found)
  found = found or { v = false }
  if type(obj) ~= 'table' then return found.v end
  for k, v in pairs(obj) do
    if k == key then
      if type(v) == 'number' then
        obj[k] = tonumber(newVal) or v
      elseif type(v) == 'boolean' then
        obj[k] = (newVal == true or newVal == 'true')
      else
        obj[k] = newVal
      end
      found.v = true
      if not deep then return found.v end
    end
    if deep and type(v) == 'table' then
      replaceKey(v, key, newVal, deep, found)
    end
  end
  return found.v
end

-- Retorna o índice final do valor JSON que começa em `i` (string com escapes,
-- objeto/array balanceados, ou token simples true/false/null/número).
local function jsonValueEnd(s, i)
  while i <= #s do
    local c = s:sub(i, i)
    if c:match('%s') then i = i + 1 else break end
  end
  if i > #s then return nil end
  local c = s:sub(i, i)
  if c == '"' then
    i = i + 1
    while i <= #s do
      local ch = s:sub(i, i)
      if ch == '\\' then i = i + 2
      elseif ch == '"' then return i
      else i = i + 1 end
    end
    return nil
  elseif c == '{' or c == '[' then
    local open, close = c, (c == '{') and '}' or ']'
    local depth = 0
    local inStr = false
    while i <= #s do
      local ch = s:sub(i, i)
      if inStr then
        if ch == '\\' then i = i + 2
        elseif ch == '"' then inStr = false; i = i + 1
        else i = i + 1 end
      elseif ch == '"' then inStr = true; i = i + 1
      elseif ch == open then depth = depth + 1; i = i + 1
      elseif ch == close then
        depth = depth - 1; i = i + 1
        if depth == 0 then return i - 1 end
      else i = i + 1 end
    end
    return nil
  else
    -- token simples: consome até delimitador de valor
    local j = i
    while j <= #s and not s:sub(j, j):match('[%s,}%]]') do j = j + 1 end
    return j - 1
  end
end

-- Modo variável: troca o valor da chave JSON. Fallback por varredura para
-- JSON inválido (padrões Lua não têm `|` nem grupos não-capturantes).
local function applyVarRule(text, key, newVal, deep)
  local obj = tryJson(text)
  if type(obj) == 'table' then
    local ok, changed = pcall(replaceKey, obj, key, newVal, deep)
    if ok and changed then return JSON.encode(obj) end
    return text
  end
  -- fallback: localiza `"key" :` e substitui o valor que segue
  local escaped = tostring(key):gsub('([%^%$%(%)%%%.%[%]%*%+%-%?])', '%%%1')
  local prefix = '"' .. escaped .. '"%s*:%s*'
  local out, pos = {}, 1
  while true do
    local _, pe = text:find(prefix, pos)
    if not pe then break end
    out[#out + 1] = text:sub(pos, pe)
    local vstart = pe + 1
    local vend = jsonValueEnd(text, vstart)
    if not vend then
      out[#out + 1] = text:sub(vstart)
      return table.concat(out)
    end
    out[#out + 1] = JSON.encode(newVal)
    pos = vend + 1
  end
  out[#out + 1] = text:sub(pos)
  return table.concat(out)
end

-- Aplica todas as regras ativas de substituição sobre um corpo textual.
local function applyRules(text, method)
  local active = Rules.active
  if not text or #active == 0 then return text end
  local isGet = (method == 'GET')
  local out = text
  for _, rule in ipairs(active) do
    if rule.enabled then
      local apply = isGet and rule.applyGet or rule.applyPost
      if apply then
        if rule.mode == 'var' then
          out = applyVarRule(out, rule.find, rule.replace, rule.deepSearch)
        else
          out = out:gsub(rule.find:gsub('(%W)', '%%%1'), function() return rule.replace end)
        end
      end
    end
  end
  return out
end

function Rules.setFromUI(rules)
  Rules.active = {}
  for _, r in ipairs(rules or {}) do
    if r.enabled then Rules.active[#Rules.active + 1] = r end
  end
end

local function rulesActiveFor(method)
  local isGet = (method == 'GET')
  for _, r in ipairs(Rules.active) do
    if r.enabled and (isGet and r.applyGet or (not isGet and r.applyPost)) then return true end
  end
  return false
end

-- ═══════════════════════════════════════════════════════════
-- ESTADO
-- ═══════════════════════════════════════════════════════════

local function loadList(key)
  local v = fsGet(key, {})
  if type(v) ~= 'table' then return {} end
  return v
end

local function loadSet(key)
  local set = {}
  for _, v in ipairs(loadList(key)) do set[tostring(v)] = true end
  return set
end

local S = {
  reqs = loadList(HK),
  ignored = loadSet(IK),
  blocked = loadSet(BK),
  rules = loadList(RK),
  icp = loadList(ICK),
  held = {},
  heldView = 'send',
  icpEdit = nil,
  filterGet = false,
  cur = nil,
  ready = false,
  view = 'send',
  minState = tonumber(fsGet(MK, 0)) or 0,
  theme = (function()
    local t = fsGet(SK, {})
    if type(t) ~= 'table' then t = {} end
    for k, v in pairs(DT) do if t[k] == nil then t[k] = v end end
    return t
  end)(),
  pos = fsGet(PK, { x = 40, y = 60 }),
  orbPos = fsGet(OK, { x = 20, y = 120 }),
  icpOn = fsGet(ICK .. '_on', false) == true,
  icpHoldReq = fsGet(ICK .. '_holdreq', true) ~= false,
  icpHoldRes = fsGet(ICK .. '_holdres', true) ~= false,
}

-- Migração: regras antigas com action='hold' eram "segurar"; hoje só bloqueio.
do
  local clean = {}
  for _, r in ipairs(S.icp) do
    if type(r) == 'table' and r.action ~= 'hold' then
      clean[#clean + 1] = {
        url = r.url or '',
        method = string.upper(tostring(r.method or 'ANY')),
        phase = r.phase or 'request',
        enabled = r.enabled ~= false,
      }
    end
  end
  S.icp = clean
end

Rules.setFromUI(S.rules)

local function saveTheme() fsSet(SK, S.theme) end
local function savePos() fsSet(PK, S.pos) end
local function saveOrbPos() fsSet(OK, S.orbPos) end
local function saveRules() fsSet(RK, S.rules); Rules.setFromUI(S.rules) end
local function saveMinState() fsSet(MK, S.minState) end
local function saveIcp() fsSet(ICK, S.icp) end
local function saveIcpOn() fsSet(ICK .. '_on', S.icpOn) end
local function saveIcpHold(which, v) fsSet(ICK .. '_' .. which, v) end

local function saveSet(key, set)
  local arr = {}
  for v in pairs(set) do arr[#arr + 1] = v end
  fsSet(key, arr)
end

local function truncBody(b)
  if b == nil then return b end
  local s = tostring(b)
  if #s > PERSIST_BODY then return s:sub(1, PERSIST_BODY) .. '\n…[truncado ao salvar]' end
  return s
end

local function persistHistoryNow(force)
  if not force and #S.reqs == 0 then return end
  local out = {}
  for i = 1, math.min(#S.reqs, PERSIST_MAX) do
    local r = S.reqs[i]
    local c = {}
    for k, v in pairs(r) do c[k] = v end
    c.reqB = truncBody(r.reqB)
    c.resB = truncBody(r.resB)
    out[i] = c
  end
  fsSet(HK, out)
end

local __histT = nil
local function saveHistory()
  if __histT then return end
  __histT = (delay or function(_, f) return f() end)(0.4, function()
    __histT = nil
    persistHistoryNow(false)
  end)
end

-- ═══════════════════════════════════════════════════════════
-- INTERCEPTAÇÃO (equivalente ao page-world hook do user.js)
-- Em Roblox não há fetch/XHR: interceptamos as APIs HTTP do executor
-- (game:HttpGet/HttpPost, HttpService:RequestAsync/GetAsync/PostAsync,
-- request/http_request). O fluxo segurar → editar → soltar é o mesmo.
-- ═══════════════════════════════════════════════════════════

local Intercept = {}
Intercept.onCapture = nil      -- função que recebe o payload (definida pela UI)
Intercept.onHeld = nil
Intercept.enabled = false
Intercept.holdReq = true
Intercept.holdRes = true
Intercept.icp = {}             -- regras de bloqueio automático
Intercept.blocked = {}         -- set de URLs bloqueadas manualmente

local decisions = {}
local autoFwd = {}
local pendingIds = {}

local function genId()
  return string.format('%x%x', math.random(0, 0xFFFFFF), math.random(0, 0xFFFFFF))
end

local function absUrl(u)
  return tostring(u or '')
end

local function isBlockedUrl(u)
  return Intercept.blocked[absUrl(u)] == true
end

local function matchBlock(url, method, phase)
  if not Intercept.enabled then return nil end
  local M = string.upper(tostring(method or 'GET'))
  for _, r in ipairs(Intercept.icp) do
    if r.enabled ~= false then
      local okPhase = (not r.phase) or r.phase == phase
      local okMethod = (not r.method) or r.method == 'ANY' or r.method == M
      local okUrl = (not r.url) or r.url == '' or absUrl(url):find(r.url, 1, true) ~= nil
      if okPhase and okMethod and okUrl then return r end
    end
  end
  return nil
end

local function shouldHold(phase)
  if not Intercept.enabled then return false end
  if phase == 'response' then return Intercept.holdRes end
  return Intercept.holdReq
end

-- Tempo máximo (s) que uma requisição pode ficar segurada sem decisão antes
-- de ser liberada automaticamente, para o jogo nunca travar de vez.
local DECISION_TIMEOUT = 60

local function waitDecision(id)
  local waited = 0
  while decisions[id] == nil do
    if waitFn then waitFn(0.03) end
    waited = waited + 0.03
    if waited >= DECISION_TIMEOUT then
      decisions[id] = { drop = false, timedOut = true }
    end
  end
  local d = decisions[id]
  decisions[id] = nil
  return d
end

function Intercept.decide(id, dec)
  decisions[id] = dec or { drop = false }
  if not dec or not dec.drop then
    autoFwd[id] = true
    pendingIds[#pendingIds + 1] = id
    if #pendingIds > 800 then
      local old = table.remove(pendingIds, 1)
      autoFwd[old] = nil
    end
  end
end

local function headersToTable(h)
  local o = {}
  if type(h) == 'table' then
    for k, v in pairs(h) do o[tostring(k):lower()] = tostring(v) end
  end
  return o
end

-- Executa a chamada HTTP real, preferindo a API do executor.
local function doHttp(method, url, headers, body)
  method = string.upper(tostring(method or 'GET'))
  local opts = { Url = url, Method = method, Headers = headers or {} }
  if body ~= nil and method ~= 'GET' and method ~= 'HEAD' then opts.Body = body end

  if hasRequest then
    local ok, res = pcall(httpRequest, opts)
    if ok and type(res) == 'table' then
      return {
        status = res.StatusCode or res.Status or 200,
        statusText = res.StatusMessage or res.StatusText or '',
        headers = headersToTable(res.Headers),
        body = res.Body,
      }
    end
  end
  -- Fallback: HttpService (usa a RequestAsync ORIGINAL, nunca a interceptada,
  -- para não recursar em installHooks).
  if originalRequestAsync then
    local ok, res = pcall(function() return originalRequestAsync(HttpService, opts) end)
    if ok and type(res) == 'table' then
      return {
        status = res.StatusCode or 200,
        statusText = res.StatusMessage or '',
        headers = headersToTable(res.Headers),
        body = res.Body,
      }
    end
  end
  error('HTTP request falhou: ' .. tostring(url))
end

-- Núcleo: dado um pedido, aplica bloqueio/segurar/regras e devolve a resposta.
-- Retorna status, statusText, headers, body, blocked.
function Intercept.perform(method, url, headers, body, kind)
  kind = kind or 'http'
  method = string.upper(tostring(method or 'GET'))
  headers = headers or {}
  local id = genId()
  local ts = nowMs()

  local function emit(payload)
    if Intercept.onCapture then pcall(Intercept.onCapture, payload) end
  end

  local function meta(extra)
    local base = {
      kind = kind, id = id, method = method, url = absUrl(url),
      requestHeaders = headers, requestPayload = body,
      responseHeaders = {}, responsePayload = nil,
      status = nil, statusText = '', timestamp = ts, patched = false,
    }
    if extra then for k, v in pairs(extra) do base[k] = v end end
    return base
  end

  if isBlockedUrl(url) then
    emit(meta({ status = 'ERR', statusText = 'Blocked', blocked = true }))
    return nil, 'Blocked', {}, nil, true
  end

  if matchBlock(url, method, 'request') then
    emit(meta({ status = 'ERR', statusText = 'Dropped', blocked = true }))
    return nil, 'Dropped', {}, nil, true
  end

  -- Segurar request (permite editar antes de enviar)
  local edited = nil
  if shouldHold('request') then
    local held = meta({ held = true, phase = 'request' })
    if Intercept.onHeld then pcall(Intercept.onHeld, held) end
    emit(held)
    local dec = waitDecision(id)
    if dec.drop then
      emit(meta({ status = 'ERR', statusText = 'Dropped', blocked = true }))
      return nil, 'Dropped', {}, nil, true
    end
    edited = dec.req
  end

  local effMethod, effUrl, effHeaders, effBody = method, url, headers, body
  if edited then
    if edited.method then effMethod = string.upper(tostring(edited.method)) end
    if edited.url then effUrl = edited.url end
    if edited.headers then effHeaders = edited.headers end
    if edited.body ~= nil then effBody = edited.body end
  end

  local res = doHttp(effMethod, effUrl, effHeaders, effBody)
  local rHeaders = res.headers or {}
  local ct = getHdr(rHeaders, 'content-type')
  local textual = isTextual(ct)
  local stream = isStream(ct)
  local rBody = res.body

  local m2 = {
    kind = kind, id = id, method = effMethod, url = absUrl(effUrl),
    requestHeaders = effHeaders, requestPayload = effBody,
    responseHeaders = rHeaders, responsePayload = rBody,
    status = res.status, statusText = res.statusText,
    timestamp = ts, patched = false,
  }

  -- Bloqueio automático de response
  if matchBlock(effUrl, effMethod, 'response') then
    local t = {}
    for k, v in pairs(m2) do t[k] = v end
    t.status = 'ERR'; t.statusText = 'Dropped'; t.blocked = true
    emit(t)
    return nil, 'Dropped', rHeaders, nil, true
  end

  -- Segurar response (permite editar o corpo antes de devolver)
  if shouldHold('response') and not autoFwd[id] then
    local held = {}
    for k, v in pairs(m2) do held[k] = v end
    held.held = true; held.phase = 'response'
    if Intercept.onHeld then pcall(Intercept.onHeld, held) end
    emit(held)
    local dec = waitDecision(id)
    if dec.drop then
      local t = {}
      for k, v in pairs(m2) do t[k] = v end
      t.status = 'ERR'; t.statusText = 'Dropped'; t.blocked = true
      emit(t)
      return nil, 'Dropped', rHeaders, nil, true
    end
    if dec.resBody ~= nil and textual and not stream then
      local t = {}
      for k, v in pairs(m2) do t[k] = v end
      t.responsePayload = dec.resBody; t.patched = dec.resBody ~= rBody
      emit(t)
      return res.status, res.statusText, rHeaders, dec.resBody, false
    end
    if textual and not stream and rBody ~= nil and rulesActiveFor(effMethod) then
      local patched = applyRules(tostring(rBody), effMethod)
      local t = {}
      for k, v in pairs(m2) do t[k] = v end
      t.responsePayload = patched; t.patched = patched ~= rBody
      emit(t)
      return res.status, res.statusText, rHeaders, patched, false
    end
    emit(m2)
    return res.status, res.statusText, rHeaders, rBody, false
  end

  -- Regras de substituição (sem segurar)
  if textual and not stream and rBody ~= nil and rulesActiveFor(effMethod) then
    local patched = applyRules(tostring(rBody), effMethod)
    local t = {}
    for k, v in pairs(m2) do t[k] = v end
    t.responsePayload = patched; t.patched = patched ~= rBody
    emit(t)
    return res.status, res.statusText, rHeaders, patched, false
  end

  emit(m2)
  return res.status, res.statusText, rHeaders, rBody, false
end

-- ═══════════════════════════════════════════════════════════
-- UI HELPERS (Roblox Instances)
-- ═══════════════════════════════════════════════════════════

local UI = {}

-- Propriedades que exigem Color3 (aceitam "#rrggbb" e convertem na hora).
local COLOR_PROPS = {
  BackgroundColor3 = true, TextColor3 = true, BorderColor3 = true,
  ImageColor3 = true, ScrollBarImageColor3 = true, Color = true,
  PlaceholderColor3 = true,
}

-- Constrói um Instance. `parent` vira o Parent padrão (usado pelos helpers
-- text/button/box quando não se passa Parent em props). Props com cor em
-- string hexadecimal são convertidas automaticamente para Color3.
local function new(class, props, parent)
  local inst = Instance.new(class)
  if props then
    for k, v in pairs(props) do
      if COLOR_PROPS[k] and type(v) == 'string' and v:match('^#%x%x%x%x%x%x$') then
        v = hex(v)
      end
      inst[k] = v
    end
  end
  if parent and inst.Parent == nil then inst.Parent = parent end
  return inst
end

local function corner(parent, r)
  new('UICorner', { CornerRadius = UDim.new(0, r or 6), Parent = parent })
end

local function stroke(parent, color, thickness, transparency)
  new('UIStroke', {
    Color = color or Color3.fromRGB(40, 40, 40),
    Thickness = thickness or 1,
    Transparency = transparency or 0,
    ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
    Parent = parent,
  })
end

local function pad(parent, l, r, t, b)
  new('UIPadding', {
    PaddingLeft = UDim.new(0, l or 0), PaddingRight = UDim.new(0, r or 0),
    PaddingTop = UDim.new(0, t or 0), PaddingBottom = UDim.new(0, b or 0),
    Parent = parent,
  })
end

local function vlist(parent, gap)
  new('UIListLayout', {
    FillDirection = Enum.FillDirection.Vertical,
    SortOrder = Enum.SortOrder.LayoutOrder,
    Padding = UDim.new(0, gap or 4),
    Parent = parent,
  })
end

local function hlist(parent, gap)
  new('UIListLayout', {
    FillDirection = Enum.FillDirection.Horizontal,
    SortOrder = Enum.SortOrder.LayoutOrder,
    Padding = UDim.new(0, gap or 4),
    VerticalAlignment = Enum.VerticalAlignment.Center,
    Parent = parent,
  })
end

local function text(parent, props)
  return new('TextLabel', props, parent)
end

local function button(parent, props)
  return new('TextButton', props, parent)
end

local function box(parent, props)
  return new('Frame', props, parent)
end

-- Botão padrão do painel. No mobile o alvo de toque é maior.
local function mkBtn(parent, label, w, color)
  local h = btnH()
  local b = button(parent, {
    Size = UDim2.new(0, w or 70, 0, h),
    BackgroundColor3 = color or S.theme.raised,
    BorderSizePixel = 0,
    Text = label,
    TextColor3 = S.theme.text,
    Font = Enum.Font.Code,
    TextSize = fs(12),
    AutoButtonColor = true,
    Parent = parent,
  })
  corner(b, 5)
  stroke(b, S.theme.border2, 1)
  return b
end

-- Campo de texto simples (TextLabel editável via box)
local function mkInput(parent, placeholder, h)
  local f = box(parent, {
    Size = UDim2.new(1, 0, 0, h or btnH()),
    BackgroundColor3 = S.theme.surface,
    BorderSizePixel = 0,
    Parent = parent,
  })
  corner(f, 5)
  stroke(f, S.theme.border, 1)
  local tb = new('TextBox', {
    Size = UDim2.new(1, -10, 1, 0),
    Position = UDim2.new(0, 5, 0, 0),
    BackgroundTransparency = 1,
    Text = '',
    PlaceholderText = placeholder or '',
    PlaceholderColor3 = S.theme.sub,
    TextColor3 = S.theme.text,
    Font = Enum.Font.Code,
    TextSize = fs(12),
    ClearTextOnFocus = false,
    TextXAlignment = Enum.TextXAlignment.Left,
    Parent = f,
  })
  return f, tb
end

-- Toggle (checkbox estilizado). Retorna um estado com `.frame`, `.on`, `.cbs`
-- e `.set(on)` (para refletir o valor sem disparar os callbacks).
local function mkToggle(parent, initial)
  local f = box(parent, {
    Size = UDim2.new(0, 34, 0, 18),
    BackgroundColor3 = initial and S.theme.accent or S.theme.raised,
    BorderSizePixel = 0,
    Parent = parent,
  })
  corner(f, 9)
  stroke(f, S.theme.border2, 1)
  local knob = box(f, {
    Size = UDim2.new(0, 14, 0, 14),
    Position = UDim2.new(0, initial and 18 or 2, 0, 2),
    BackgroundColor3 = S.theme.text,
    BorderSizePixel = 0,
    Parent = f,
  })
  corner(knob, 7)
  local state = { on = initial and true or false, cbs = {}, frame = f }
  function state.set(on)
    state.on = on and true or false
    f.BackgroundColor3 = hex(state.on and S.theme.accent or S.theme.raised)
    knob.Position = UDim2.new(0, state.on and 18 or 2, 0, 2)
  end
  local btn = button(f, {
    Size = UDim2.new(1, 0, 1, 0),
    BackgroundTransparency = 1,
    Text = '',
    Parent = f,
  })
  btn.MouseButton1Click:Connect(function()
    state.set(not state.on)
    for _, cb in ipairs(state.cbs) do pcall(cb, state.on) end
  end)
  return state
end

-- Overlay fullscreen base
local function mkOverlay(parent, title)
  local ov = box(parent, {
    Size = UDim2.new(1, 0, 1, 0),
    BackgroundColor3 = S.theme.bg,
    BackgroundTransparency = 0.02,
    BorderSizePixel = 0,
    Visible = false,
    ZIndex = 20,
    Parent = parent,
  })
  local hdr = box(ov, {
    Size = UDim2.new(1, 0, 0, 36),
    BackgroundColor3 = S.theme.raised,
    BorderSizePixel = 0,
    Parent = ov,
  })
  local back = mkBtn(hdr, '← Voltar', 80)
  back.Position = UDim2.new(0, 8, 0, 5)
  local t = text(hdr, {
    Size = UDim2.new(1, -200, 1, 0),
    Position = UDim2.new(0, 96, 0, 0),
    BackgroundTransparency = 1,
    Text = title or '',
    TextColor3 = S.theme.accent,
    Font = Enum.Font.Code,
    TextSize = fs(13),
    TextXAlignment = Enum.TextXAlignment.Left,
    Parent = hdr,
  })
  local scroll = new('ScrollingFrame', {
    Size = UDim2.new(1, 0, 1, -36),
    Position = UDim2.new(0, 0, 0, 36),
    BackgroundTransparency = 1,
    BorderSizePixel = 0,
    CanvasSize = UDim2.new(0, 0, 0, 0),
    AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 6,
    ScrollBarImageColor3 = S.theme.border2,
    Parent = ov,
  })
  vlist(scroll, 8)
  pad(scroll, 10, 10, 10, 10)
  return ov, scroll, t, back
end

-- ═══════════════════════════════════════════════════════════
-- LÓGICA DE LISTA / HISTÓRICO
-- ═══════════════════════════════════════════════════════════

local function fmtUrl(u) return tostring(u or '') end

-- Limite de exibição de corpos no detalhe. Um corpo enorme (ex.: log antiga
-- salva antes do truncamento, ou JSON minificado de um único "token") num
-- TextLabel com TextWrapped + AutomaticSize.Y trava o motor de layout do
-- Roblox. Cortamos a exibição e mostramos quanto foi omitido.
local VIEW_BODY_MAX = 8000
local function clipBody(s)
  if s == nil then return '[Empty]' end
  s = tostring(s)
  if #s <= VIEW_BODY_MAX then return s end
  return s:sub(1, VIEW_BODY_MAX) ..
    '\n…[' .. tostring(#s - VIEW_BODY_MAX) .. ' caracteres omitidos]'
end

local function clipText(s, max)
  s = tostring(s or '')
  if #s <= max then return s end
  return s:sub(1, max) .. '…'
end

local function hide(r)
  if not r or not r.url or r.url == '' then return true end
  if S.ignored[r.url] or S.blocked[r.url] then return true end
  if S.filterGet and r.method == 'GET' and tonumber(r.status) and tonumber(r.status) >= 200 and tonumber(r.status) < 300 then
    return true
  end
  return false
end

local function visible()
  local out = {}
  for _, r in ipairs(S.reqs) do if not hide(r) then out[#out + 1] = r end end
  return out
end

local function isSend(r)
  return r.method ~= 'GET' or (r.reqB and tostring(r.reqB):match('%S') ~= nil)
end

-- Corta o corpo guardado no histórico para um teto absoluto. Evita que um
-- corpo gigante (ex.: download de centenas de KB) entre na memória e trave a
-- renderização. O corpo real devolvido ao jogo não passa por aqui.
local function storeBody(b)
  if b == nil then return nil end
  local s = tostring(b)
  if #s <= MAX_BODY then return b end
  return s:sub(1, MAX_BODY) .. '\n…[truncado: ' .. tostring(#s) .. ' bytes]'
end

-- Sanitiza o histórico carregado do disco: logs salvas antes do truncamento
-- podem ter corpos acima do teto, que travariam a renderização ao abri-las.
for _, r in ipairs(S.reqs) do
  if type(r) == 'table' then
    r.reqB = storeBody(r.reqB)
    r.resB = storeBody(r.resB)
  end
end

local function addReq(req)
  local r = {
    id = req.id or genId(),
    type = req.type or '?',
    method = string.upper(tostring(req.method or 'GET')),
    url = fmtUrl(req.url or ''),
    reqH = req.requestHeaders or {},
    reqB = storeBody(req.requestPayload),
    resH = req.responseHeaders or {},
    resB = storeBody(req.responsePayload),
    status = req.status,
    stxt = req.statusText or '',
    ts = req.timestamp or nowMs(),
    patched = req.patched or false,
  }
  table.insert(S.reqs, 1, r)
  while #S.reqs > MAX_REQ do table.remove(S.reqs) end
  saveHistory()
  if S.ready then UI.renderList() end
end
UI.addReq = addReq

-- ═══════════════════════════════════════════════════════════
-- UI PRINCIPAL
-- ═══════════════════════════════════════════════════════════

function UI.build()
  if S.ready then return end
  S.ready = true

  local gui = new('ScreenGui', {
    Name = 'BurpImpure',
    ResetOnSpawn = false,
    IgnoreGuiInset = true,
    ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
    DisplayOrder = 2147483647,
    Parent = CoreGui,
  })
  UI.gui = gui

  -- ── Painel ──
  local rootW, rootH = rootDims()
  local root = box(gui, {
    Name = 'bip',
    Size = UDim2.new(0, rootW, 0, rootH),
    Position = UDim2.new(0, S.pos.x or 40, 0, S.pos.y or 60),
    BackgroundColor3 = S.theme.bg,
    BorderSizePixel = 0,
    ZIndex = 10,
  })
  corner(root, 10)
  stroke(root, S.theme.border2, 1)
  UI.root = root
  UI.rootW, UI.rootH = rootW, rootH

  -- Header (arrastável)
  local hdr = box(root, {
    Name = 'hdr',
    Size = UDim2.new(1, 0, 0, 40),
    BackgroundColor3 = S.theme.raised,
    BorderSizePixel = 0,
    ZIndex = 11,
  })
  corner(hdr, 10)
  box(hdr, {
    Size = UDim2.new(1, 0, 0, 20),
    Position = UDim2.new(0, 0, 1, -20),
    BackgroundColor3 = S.theme.raised,
    BorderSizePixel = 0,
    ZIndex = 11,
    Parent = hdr,
  })
  text(hdr, {
    Size = UDim2.new(1, -160, 1, 0), Position = UDim2.new(0, 12, 0, 0),
    BackgroundTransparency = 1, Text = 'BurpImpure', TextColor3 = S.theme.accent,
    Font = Enum.Font.Code, TextSize = fs(15), TextXAlignment = Enum.TextXAlignment.Left,
    TextTruncate = Enum.TextTruncate.AtEnd, ZIndex = 12, Parent = hdr,
  })
  local badge = text(hdr, {
    Size = UDim2.new(0, 34, 0, 18), Position = UDim2.new(0, 120, 0, 11),
    BackgroundColor3 = S.theme.accent, Text = '0', TextColor3 = S.theme.bg,
    Font = Enum.Font.Code, TextSize = fs(11), ZIndex = 12, Parent = hdr,
  })
  corner(badge, 9)
  UI.badge = badge

  -- Botões do header: maiores no mobile (alvo de toque) e afastados da borda.
  local hbW = isCompact() and 32 or 30
  local closeBtn = mkBtn(hdr, '✕', hbW, S.theme.raised)
  closeBtn.Position = UDim2.new(1, -(hbW + 8), 0, 5); closeBtn.ZIndex = 12
  local orbBtn = mkBtn(hdr, '◉', hbW, S.theme.raised)
  orbBtn.Position = UDim2.new(1, -(hbW * 2 + 14), 0, 5); orbBtn.ZIndex = 12

  -- Tabs (largura fixa no desktop; proporcional em telas estreitas)
  local tabs = box(root, {
    Size = UDim2.new(1, 0, 0, 34), Position = UDim2.new(0, 0, 0, 40),
    BackgroundColor3 = S.theme.surface, BorderSizePixel = 0, ZIndex = 10, Parent = root,
  })
  hlist(tabs, 0)
  pad(tabs, 6, 6, 4, 4)

  local tabDefs = {
    { id = 'send', label = 'Send' }, { id = 'recv', label = 'Receive' },
    { id = 'icp', label = 'Intercept' }, { id = 'cfg', label = 'Config' },
  }
  local tabButtons = {}
  for _, def in ipairs(tabDefs) do
    local tb = button(tabs, {
      Size = UDim2.new(1 / #tabDefs, -2, 1, 0), BackgroundColor3 = S.theme.raised,
      BackgroundTransparency = def.id == 'send' and 0 or 0.4,
      Text = def.label, TextColor3 = S.theme.text, Font = Enum.Font.Code,
      TextSize = fs(12), TextScaled = isCompact(), BorderSizePixel = 0,
      LayoutOrder = #tabButtons, Parent = tabs,
    })
    corner(tb, 5)
    tabButtons[def.id] = tb
  end

  -- Body
  local body = box(root, {
    Size = UDim2.new(1, 0, 1, -74), Position = UDim2.new(0, 0, 0, 74),
    BackgroundTransparency = 1, BorderSizePixel = 0, ZIndex = 10, Parent = root,
  })
  UI.body = body

  local pages = {}
  for _, def in ipairs(tabDefs) do
    local p = box(body, {
      Name = 'pg-' .. def.id, Size = UDim2.new(1, 0, 1, 0),
      BackgroundTransparency = 1, BorderSizePixel = 0, Visible = def.id == 'send',
      ZIndex = 10, Parent = body,
    })
    pages[def.id] = p
  end
  UI.pages = pages

  -- Página Send / Receive (lista)
  local function mkListPage(pg)
    local sf = new('ScrollingFrame', {
      Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0,
      CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y,
      ScrollBarThickness = 5, ScrollBarImageColor3 = S.theme.border2, Parent = pg,
    })
    vlist(sf, 3); pad(sf, 8, 8, 8, 8)
    return sf
  end
  UI.listSend = mkListPage(pages.send)
  UI.listRecv = mkListPage(pages.recv)

  -- Troca de aba
  local function selectTab(id)
    for tid, tb in pairs(tabButtons) do
      tb.BackgroundTransparency = tid == id and 0 or 0.4
      tb.TextColor3 = hex(tid == id and S.theme.accent or S.theme.text)
    end
    for pid, p in pairs(pages) do p.Visible = pid == id end
    if id == 'icp' then UI.renderHeld(); UI.renderIcpRules() end
    if id == 'send' or id == 'recv' then UI.renderList() end
    if id == 'cfg' then UI.syncCfg() end
  end
  UI.selectTab = selectTab
  for id, tb in pairs(tabButtons) do
    tb.MouseButton1Click:Connect(function() selectTab(id) end)
  end

  -- Fechar / orb
  closeBtn.MouseButton1Click:Connect(function()
    root.Visible = false
    UI.orb.Visible = true
  end)
  orbBtn.MouseButton1Click:Connect(function() UI.setMin(2) end)

  -- ── Orb ──
  local orb = box(gui, {
    Name = 'orb', Size = UDim2.new(0, 46, 0, 46),
    Position = UDim2.new(0, S.orbPos.x or 20, 0, S.orbPos.y or 120),
    BackgroundColor3 = S.theme.raised, BorderSizePixel = 0, Visible = false, ZIndex = 30,
  })
  corner(orb, 23); stroke(orb, S.theme.accent, 1)
  UI.orb = orb
  local orbLabel = text(orb, {
    Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, Text = 'B',
    TextColor3 = S.theme.accent, Font = Enum.Font.Code, TextSize = fs(20), Parent = orb,
  })
  UI.orbN = orbLabel
  local orbClick = button(orb, { Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, Text = '', Parent = orb })
  orbClick.MouseButton1Click:Connect(function()
    orb.Visible = false
    root.Visible = true
    UI.setMin(0)
  end)

  -- Drag do header
  UI.installDrag(root, hdr)
  UI.installOrbDrag(orb, orbClick)

  -- Overlays
  UI.detOv, UI.detScroll, UI.detTitle, UI.detBack = mkOverlay(root, 'Request Detail')
  UI.repOv, UI.repScroll = mkOverlay(root, 'Repeater')
  UI.icpOv, UI.icpScroll, UI.icpTitle = mkOverlay(root, 'Editar interceptado')

  UI.detBack.MouseButton1Click:Connect(function() UI.detOv.Visible = false end)

  UI.buildRepeater(UI.repScroll)
  UI.buildIcpEditor(UI.icpScroll)
  UI.buildConfig(pages.cfg)
  UI.buildIntercept(pages.icp)

  -- Painel de regras (na aba Receive, como no userscript)
  UI.buildRulesPanel(pages.recv)

  UI.renderList()
  UI.renderHeld()
  UI.renderIcpRules()
  UI.syncCfg()
  UI.setMin(S.minState)
end

-- ── Renderização da lista ──
function UI.renderList()
  local all = visible()
  local sends, recvs = {}, {}
  for _, r in ipairs(all) do
    if isSend(r) then sends[#sends + 1] = r else recvs[#recvs + 1] = r end
  end
  UI.fillList(UI.listSend, sends, 'Nenhum request de saída ainda.\nFaça POST/PUT/PATCH para vê-los aqui.')
  UI.fillList(UI.listRecv, recvs, 'Nenhum GET ainda.\nNavegue para capturar tráfego.')

  if UI.badge then UI.badge.Text = tostring(#all) end
  if UI.orbN then UI.orbN.Text = tostring(#all) end
end

function UI.fillList(sf, list, emptyMsg)
  if not sf then return end
  for _, c in ipairs(sf:GetChildren()) do
    if c:IsA('Frame') or c:IsA('TextLabel') then c:Destroy() end
  end
  if #list == 0 then
    text(sf, {
      Size = UDim2.new(1, 0, 0, 60), BackgroundTransparency = 1,
      Text = emptyMsg, TextColor3 = S.theme.sub, Font = Enum.Font.Code,
      TextSize = fs(11), TextWrapped = true, Parent = sf,
    })
    return
  end
  for i, r in ipairs(list) do
    UI.makeRow(sf, r, i)
  end
end

function UI.makeRow(parent, r, order)
  local sc = statusClass(r.status)
  local scColor = sc == 's5' and S.theme.danger or sc == 's4' and S.theme.warn
    or sc == 's2' and S.theme.ok or S.theme.sub
  local row = button(parent, {
    Size = UDim2.new(1, 0, 0, 42), BackgroundColor3 = S.theme.surface,
    BackgroundTransparency = 0.15, Text = '', BorderSizePixel = 0,
    LayoutOrder = order, AutoButtonColor = true, Parent = parent,
  })
  corner(row, 5)
  stroke(row, r.patched and S.theme.accent or S.theme.border, 1)

  -- faixa de método
  local strip = box(row, {
    Size = UDim2.new(0, 3, 1, -10), Position = UDim2.new(0, 0, 0, 5),
    BackgroundColor3 = scColor, BorderSizePixel = 0, Parent = row,
  })
  corner(strip, 2)

  -- Colunas adaptativas: em telas estreitas reduzimos método/status/tempo para
  -- a URL não sobrepor os demais campos.
  local compact = isCompact()
  local mX, mW = 8, compact and 44 or 54
  local rightW = compact and 96 or 118  -- status + tempo
  local urlX = mX + mW + 6
  text(row, {
    Size = UDim2.new(0, mW, 1, 0), Position = UDim2.new(0, mX, 0, 0),
    BackgroundTransparency = 1, Text = r.method, TextColor3 = S.theme.accent,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Left,
    TextTruncate = Enum.TextTruncate.AtEnd, Parent = row,
  })
  text(row, {
    Size = UDim2.new(1, -(urlX + rightW), 1, 0), Position = UDim2.new(0, urlX, 0, 0),
    BackgroundTransparency = 1, Text = shortUrl(r.url), TextColor3 = S.theme.text,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Left,
    TextTruncate = Enum.TextTruncate.AtEnd, Parent = row,
  })
  text(row, {
    Size = UDim2.new(0, 40, 1, 0), Position = UDim2.new(1, -(rightW - 4), 0, 0),
    BackgroundTransparency = 1, Text = tostring(r.status or '…'), TextColor3 = scColor,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Right, Parent = row,
  })
  text(row, {
    Size = UDim2.new(0, compact and 46 or 56, 1, 0), Position = UDim2.new(1, -(compact and 50 or 60), 0, 0),
    BackgroundTransparency = 1, Text = relTime(r.ts), TextColor3 = S.theme.sub,
    Font = Enum.Font.Code, TextSize = fs(10), TextXAlignment = Enum.TextXAlignment.Right, Parent = row,
  })
  row.MouseButton1Click:Connect(function() UI.showDetail(r) end)
  return row
end

-- ── Detail ──
function UI.showDetail(r)
  S.cur = r
  local ov = UI.detOv
  if not ov then return end
  UI.repOv.Visible = false
  ov.Visible = true
  UI.detTitle.Text = shortUrl(r.url)

  local sc = UI.detScroll
  for _, c in ipairs(sc:GetChildren()) do
    if not c:IsA('UIListLayout') and not c:IsA('UIPadding') then c:Destroy() end
  end

  local function section(title, body)
    text(sc, {
      Size = UDim2.new(1, 0, 0, 18), BackgroundTransparency = 1, Text = title,
      TextColor3 = S.theme.accent, Font = Enum.Font.Code, TextSize = fs(12),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = sc,
    })
    local b = text(sc, {
      Size = UDim2.new(1, 0, 0, 0), BackgroundColor3 = S.theme.surface,
      BackgroundTransparency = 0.2, Text = body or '', TextColor3 = S.theme.text,
      Font = Enum.Font.Code, TextSize = fs(11), TextWrapped = true, TextXAlignment = Enum.TextXAlignment.Left,
      TextYAlignment = Enum.TextYAlignment.Top, AutomaticSize = Enum.AutomaticSize.Y,
      Parent = sc,
    })
    pad(b, 8, 8, 6, 6)
    corner(b, 4)
    return b
  end

  section('URL', r.url)
  section('Method', r.method)
  section('Status', tostring(r.status or '') .. ' ' .. tostring(r.stxt or ''))
  section('Type', tostring(r.type) .. (r.patched and '  ★ PATCHED' or ''))
  section('Request Headers', clipText(JSON.encode(r.reqH or {}), VIEW_BODY_MAX))
  section('Request Body', clipBody(r.reqB))
  section('Response Headers', clipText(JSON.encode(r.resH or {}), VIEW_BODY_MAX))
  section('Response Body', clipBody(r.resB))

  -- barra de ações
  local actBar = box(sc, {
    Size = UDim2.new(1, 0, 0, btnH() + 4), BackgroundTransparency = 1, Parent = sc,
  })
  hlist(actBar, 6)
  local rep = mkBtn(actBar, '↻ Repeater', 100, S.theme.raised)
  local cpy = mkBtn(actBar, '⧉ Copiar URL', 110, S.theme.raised)
  local ign = mkBtn(actBar, '⊘ Ignorar', 90, S.theme.raised)
  local blk = mkBtn(actBar, '✕ Bloquear', 90, S.theme.raised)
  -- Em telas estreitas divide a largura em partes iguais para não estourar.
  if isCompact() then
    local labels = { { rep, '↻' }, { cpy, '⧉' }, { ign, '⊘' }, { blk, '✕' } }
    for _, pair in ipairs(labels) do
      pair[1].Size = UDim2.new(1 / #labels, -5, 0, btnH())
      pair[1].Text = pair[2]
      pair[1].TextSize = fs(14)
    end
  end
  rep.MouseButton1Click:Connect(function() UI.openRep(r) end)
  cpy.MouseButton1Click:Connect(function()
    if setClipboard then pcall(setClipboard, r.url) end
    UI.toast('URL copiada', 'ok')
  end)
  ign.MouseButton1Click:Connect(function()
    S.ignored[r.url] = true; saveSet(IK, S.ignored)
    ov.Visible = false; UI.renderList()
  end)
  blk.MouseButton1Click:Connect(function()
    S.blocked[r.url] = true; saveSet(BK, S.blocked)
    Intercept.blocked[r.url] = true
    ov.Visible = false; UI.renderList()
  end)
end

-- ── Repeater ──
function UI.buildRepeater(sc)
  local function label(t)
    text(sc, {
      Size = UDim2.new(1, 0, 0, 16), BackgroundTransparency = 1, Text = t,
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = sc,
    })
  end
  label('Method')
  local _, methodBox = mkInput(sc, 'GET', 28)
  label('URL')
  local _, urlBox = mkInput(sc, 'https://…', 28)
  label('Headers (JSON)')
  local _, hdrBox = mkInput(sc, '{"Content-Type":"application/json"}', 60)
  hdrBox.MultiLine = true
  label('Body')
  local _, bodyBox = mkInput(sc, 'Corpo da requisição…', 80)
  bodyBox.MultiLine = true

  local send = mkBtn(sc, '▶ Enviar', 120, S.theme.accent)
  send.TextColor3 = hex(S.theme.bg)

  UI.repFields = { method = methodBox, url = urlBox, headers = hdrBox, body = bodyBox }

  send.MouseButton1Click:Connect(function()
    local method = string.upper(methodBox.Text ~= '' and methodBox.Text or 'GET')
    local url = urlBox.Text
    local headers = tryJson(hdrBox.Text) or {}
    local body = bodyBox.Text
    if url == '' then UI.toast('URL vazia', 'err'); return end
    spawn(function()
      local ok, status, stxt, rh, rb = pcall(Intercept.perform, method, url, headers, body, 'Repeater')
      if ok and status then
        addReq({
          id = genId() .. '-R', type = 'Repeater', method = method, url = url,
          requestHeaders = headers, requestPayload = body,
          responseHeaders = rh or {}, responsePayload = rb,
          status = status, statusText = stxt, timestamp = nowMs(),
        })
        UI.toast(tostring(status) .. ' ' .. tostring(stxt), tonumber(status) and tonumber(status) < 400 and 'ok' or 'err')
      else
        UI.toast('Erro: ' .. tostring(status), 'err')
      end
    end)
  end)
end

function UI.openRep(r)
  if not r then return end
  UI.detOv.Visible = false
  UI.repOv.Visible = true
  local f = UI.repFields
  f.method.Text = r.method or 'GET'
  f.url.Text = r.url or ''
  f.headers.Text = clipText(JSON.encode(r.reqH or {}), VIEW_BODY_MAX)
  f.body.Text = type(r.reqB) == 'string' and clipBody(r.reqB)
    or (r.reqB ~= nil and clipText(JSON.encode(r.reqB), VIEW_BODY_MAX) or '')
end

-- ── Editor de interceptado ──
function UI.buildIcpEditor(sc)
  local function label(t)
    text(sc, {
      Size = UDim2.new(1, 0, 0, 16), BackgroundTransparency = 1, Text = t,
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = sc,
    })
  end
  label('Method')
  local _, ieMethod = mkInput(sc, 'GET', 28)
  label('URL')
  local _, ieUrl = mkInput(sc, '', 28)
  label('Headers (JSON)')
  local _, ieHeaders = mkInput(sc, '{}', 60)
  ieHeaders.MultiLine = true
  label('Body')
  local _, ieBody = mkInput(sc, '', 80)
  ieBody.MultiLine = true
  label('Response Body (se for resposta)')
  local _, ieRBody = mkInput(sc, '', 80)
  ieRBody.MultiLine = true

  local bar = box(sc, { Size = UDim2.new(1, 0, 0, btnH() + 4), BackgroundTransparency = 1, Parent = sc })
  hlist(bar, 6)
  local flow = mkBtn(bar, '▶ Soltar', 100, S.theme.ok)
  local drop = mkBtn(bar, '✕ Bloquear', 100, S.theme.danger)
  local back = mkBtn(bar, '← Voltar', 90, S.theme.raised)
  if isCompact() then
    local trio = { { flow, '▶' }, { drop, '✕' }, { back, '←' } }
    for _, pair in ipairs(trio) do
      pair[1].Size = UDim2.new(1 / #trio, -4, 0, btnH())
      pair[1].Text = pair[2]
      pair[1].TextSize = fs(14)
    end
  end

  UI.ieFields = { method = ieMethod, url = ieUrl, headers = ieHeaders, body = ieBody, rbody = ieRBody }

  flow.MouseButton1Click:Connect(function()
    local h = S.icpEdit
    if not h then return end
    if h.phase == 'response' then
      UI.decideHeld(h, { drop = false, resBody = ieRBody.Text })
    else
      local headers = tryJson(ieHeaders.Text)
      if headers == nil then UI.toast('Headers JSON inválido', 'err'); return end
      UI.decideHeld(h, { drop = false, req = {
        method = string.upper(ieMethod.Text ~= '' and ieMethod.Text or h.method),
        url = ieUrl.Text ~= '' and ieUrl.Text or h.url,
        headers = headers,
        body = ieBody.Text,
      } })
    end
  end)
  drop.MouseButton1Click:Connect(function()
    if S.icpEdit then UI.decideHeld(S.icpEdit, { drop = true }) end
  end)
  back.MouseButton1Click:Connect(function()
    S.icpEdit = nil; UI.icpOv.Visible = false
  end)
end

function UI.openIcpEditor(h)
  local ov = UI.icpOv
  if not ov then return end
  S.icpEdit = h
  ov.Visible = true
  UI.detOv.Visible = false
  UI.repOv.Visible = false
  UI.icpTitle.Text = shortUrl(h.url)
  local f = UI.ieFields
  f.method.Text = h.method or 'GET'
  f.url.Text = h.url or ''
  f.headers.Text = clipText(JSON.encode(h.reqH or {}), VIEW_BODY_MAX)
  f.body.Text = type(h.reqB) == 'string' and clipBody(h.reqB)
    or (h.reqB ~= nil and clipText(JSON.encode(h.reqB), VIEW_BODY_MAX) or '')
  f.rbody.Text = h.resB ~= nil and clipBody(h.resB) or ''
end

-- ── Fila de interceptação (segurar → editar → soltar) ──
function UI.decideHeld(h, dec)
  if not h then return end
  Intercept.decide(h.id, dec)
  for i, x in ipairs(S.held) do
    if x == h or (x.id == h.id and x.phase == h.phase) then
      table.remove(S.held, i)
      break
    end
  end
  if S.icpEdit == h then S.icpEdit = nil; UI.icpOv.Visible = false end
  UI.renderHeld()
  UI.toast(dec and dec.drop and 'Bloqueado' or 'Solto', dec and dec.drop and 'err' or 'ok')
end

function UI.heldVisible()
  local want = S.heldView == 'get' and 'response' or 'request'
  local out = {}
  for _, h in ipairs(S.held) do
    local ph = h.phase == 'response' and 'response' or 'request'
    if ph == want then out[#out + 1] = h end
  end
  return out
end

function UI.flowAllHeld()
  for _, h in ipairs(table.clone and table.clone(S.held) or S.held) do
    UI.decideHeld(h, { drop = false })
  end
end

function UI.flowVisibleHeld()
  for _, h in ipairs(UI.heldVisible()) do
    UI.decideHeld(h, { drop = false })
  end
end

function UI.renderHeld()
  if not UI.heldBox then return end
  local reqN, resN = 0, 0
  for _, h in ipairs(S.held) do
    if h.phase == 'response' then resN = resN + 1 else reqN = reqN + 1 end
  end
  if UI.icpBadge then UI.icpBadge.Text = #S.held > 0 and tostring(#S.held) or '' end
  if UI.icpTcSend then UI.icpTcSend.Text = reqN > 0 and tostring(reqN) or '' end
  if UI.icpTcGet then UI.icpTcGet.Text = resN > 0 and tostring(resN) or '' end

  local container = UI.heldBox
  for _, c in ipairs(container:GetChildren()) do
    if c:IsA('Frame') or c:IsA('TextLabel') then c:Destroy() end
  end
  local list = UI.heldVisible()
  if #list == 0 then
    text(container, {
      Size = UDim2.new(1, 0, 0, 50), BackgroundTransparency = 1,
      Text = 'Nada segurado aqui. Com a interceptação ligada, cada request fica nesta fila aguardando você editar e soltar (ou bloquear).',
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11), TextWrapped = true, Parent = container,
    })
    return
  end
  for i, h in ipairs(list) do
    local rowH = btnH() + 40
    local row = box(container, {
      Size = UDim2.new(1, 0, 0, rowH), BackgroundColor3 = S.theme.surface,
      BackgroundTransparency = 0.15, BorderSizePixel = 0, LayoutOrder = i, Parent = container,
    })
    corner(row, 5); stroke(row, S.theme.border, 1)
    text(row, {
      Size = UDim2.new(1, -10, 0, 16), Position = UDim2.new(0, 6, 0, 4),
      BackgroundTransparency = 1,
      Text = (h.phase == 'response' and 'RECEBENDO  ' or 'ENVIANDO  ') .. h.method .. '  ' .. shortUrl(h.url),
      TextColor3 = h.phase == 'response' and S.theme.warn or S.theme.accent,
      Font = Enum.Font.Code, TextSize = fs(10), TextXAlignment = Enum.TextXAlignment.Left,
      TextTruncate = Enum.TextTruncate.AtEnd, Parent = row,
    })
    local bar = box(row, {
      Size = UDim2.new(1, -10, 0, btnH()), Position = UDim2.new(0, 5, 0, 22),
      BackgroundTransparency = 1, Parent = row,
    })
    hlist(bar, 5)
    local flow = mkBtn(bar, '▶ Soltar', 84, S.theme.ok)
    local drop = mkBtn(bar, '✕ Bloquear', 84, S.theme.danger)
    local edit = mkBtn(bar, '✎ Editar', 84, S.theme.raised)
    if isCompact() then
      local trio = { { flow, '▶' }, { drop, '✕' }, { edit, '✎' } }
      for _, pair in ipairs(trio) do
        pair[1].Size = UDim2.new(1 / #trio, -4, 0, btnH())
        pair[1].Text = pair[2]
        pair[1].TextSize = fs(14)
      end
    end
    flow.MouseButton1Click:Connect(function() UI.decideHeld(h, { drop = false }) end)
    drop.MouseButton1Click:Connect(function() UI.decideHeld(h, { drop = true }) end)
    edit.MouseButton1Click:Connect(function() UI.openIcpEditor(h) end)
  end
end

function UI.buildIntercept(pg)
  local wrap = box(pg, {
    Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0, Parent = pg,
  })
  vlist(wrap, 6); pad(wrap, 10, 10, 10, 10)

  -- Cabeçalho: master + fluir tudo
  local head = box(wrap, { Size = UDim2.new(1, 0, 0, 30), BackgroundTransparency = 1, Parent = wrap })
  local state = mkToggle(head, S.icpOn)
  state.frame.Position = UDim2.new(0, 0, 0, 6)
  state.cbs[#state.cbs + 1] = function(on)
    S.icpOn = on; saveIcpOn()
    Intercept.enabled = on
    if not on then UI.flowAllHeld() end
    UI.syncIcpMaster()
  end
  text(head, {
    Size = UDim2.new(1, -180, 1, 0), Position = UDim2.new(0, 44, 0, 0),
    BackgroundTransparency = 1, Text = 'Interceptar', TextColor3 = S.theme.text,
    Font = Enum.Font.Code, TextSize = fs(12), TextXAlignment = Enum.TextXAlignment.Left,
    TextTruncate = Enum.TextTruncate.AtEnd, Parent = head,
  })
  local stateLbl = text(head, {
    Size = UDim2.new(0, 60, 1, 0), Position = UDim2.new(0, 110, 0, 0),
    BackgroundTransparency = 1, Text = S.icpOn and 'on' or 'off',
    TextColor3 = S.icpOn and S.theme.ok or S.theme.sub,
    Font = Enum.Font.Code, TextSize = fs(12), TextXAlignment = Enum.TextXAlignment.Left, Parent = head,
  })
  UI.icpStateLbl = stateLbl
  UI.icpToggle = state
  local flowW = isCompact() and 96 or 110
  local flowAll = mkBtn(head, isCompact() and '▶ Fluir' or '▶ Fluir tudo', flowW, S.theme.ok)
  flowAll.Position = UDim2.new(1, -(flowW + 2), 0, 2)
  flowAll.MouseButton1Click:Connect(function() UI.flowAllHeld() end)

  -- Sub-toggles: segurar envio / recepção (empilhados em telas estreitas).
  local holdsH = isCompact() and 56 or 26
  local holds = box(wrap, { Size = UDim2.new(1, 0, 0, holdsH), BackgroundTransparency = 1, Parent = wrap })
  local hReq = mkToggle(holds, S.icpHoldReq)
  hReq.frame.Position = UDim2.new(0, 0, 0, 4)
  hReq.cbs[#hReq.cbs + 1] = function(on)
    S.icpHoldReq = on; saveIcpHold('holdreq', on); Intercept.holdReq = on
  end
  text(holds, {
    Size = UDim2.new(1, -50, 0, 20), Position = UDim2.new(0, 42, 0, 0),
    BackgroundTransparency = 1, Text = 'Segurar envio', TextColor3 = S.theme.text,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Left, Parent = holds,
  })
  local hRes = mkToggle(holds, S.icpHoldRes)
  hRes.frame.Position = isCompact() and UDim2.new(0, 0, 0, 32) or UDim2.new(0, 190, 0, 4)
  hRes.cbs[#hRes.cbs + 1] = function(on)
    S.icpHoldRes = on; saveIcpHold('holdres', on); Intercept.holdRes = on
  end
  text(holds, {
    Size = UDim2.new(1, -50, 0, 20),
    Position = isCompact() and UDim2.new(0, 42, 0, 28) or UDim2.new(0, 232, 0, 0),
    BackgroundTransparency = 1, Text = 'Segurar recepção', TextColor3 = S.theme.text,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Left, Parent = holds,
  })

  -- Sub-abas Send / Get
  local subtabs = box(wrap, { Size = UDim2.new(1, 0, 0, btnH()), BackgroundTransparency = 1, Parent = wrap })
  hlist(subtabs, 4)
  local sendTab = mkBtn(subtabs, 'Send', 70, S.theme.raised)
  local getTab = mkBtn(subtabs, 'Get', 70, S.theme.raised)
  local function renderSubtabs()
    sendTab.BackgroundColor3 = hex(S.heldView == 'send' and S.theme.accent or S.theme.raised)
    sendTab.TextColor3 = hex(S.heldView == 'send' and S.theme.bg or S.theme.text)
    getTab.BackgroundColor3 = hex(S.heldView == 'get' and S.theme.accent or S.theme.raised)
    getTab.TextColor3 = hex(S.heldView == 'get' and S.theme.bg or S.theme.text)
  end
  sendTab.MouseButton1Click:Connect(function() S.heldView = 'send'; renderSubtabs(); UI.renderHeld() end)
  getTab.MouseButton1Click:Connect(function() S.heldView = 'get'; renderSubtabs(); UI.renderHeld() end)
  renderSubtabs()
  local flowVis = mkBtn(subtabs, '▶ Fluir esta aba', 120, S.theme.ok)
  flowVis.MouseButton1Click:Connect(function() UI.flowVisibleHeld() end)

  -- Fila (scrolling)
  local heldScroll = new('ScrollingFrame', {
    Size = UDim2.new(1, 0, 0, 200), BackgroundTransparency = 1, BorderSizePixel = 0,
    CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 5, ScrollBarImageColor3 = S.theme.border2, Parent = wrap,
  })
  vlist(heldScroll, 5)
  UI.heldBox = heldScroll

  -- Regras de bloqueio automático
  text(wrap, {
    Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1, Text = 'Bloqueio automático (regras)',
    TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11),
    TextXAlignment = Enum.TextXAlignment.Left, Parent = wrap,
  })
  local addBar = box(wrap, { Size = UDim2.new(1, 0, 0, btnH()), BackgroundTransparency = 1, Parent = wrap })
  local addBtn = mkBtn(addBar, '＋ Nova regra', 120, S.theme.accent)
  addBtn.TextColor3 = hex(S.theme.bg)
  addBtn.MouseButton1Click:Connect(function() UI.openIcpModal() end)

  local rulesBox = box(wrap, { Size = UDim2.new(1, 0, 0, 0), BackgroundTransparency = 1, Parent = wrap })
  vlist(rulesBox, 4)
  UI.icpRulesBox = rulesBox
end

function UI.syncIcpMaster()
  if UI.icpToggle then UI.icpToggle.on = S.icpOn; end
  if UI.icpStateLbl then
    UI.icpStateLbl.Text = S.icpOn and 'on' or 'off'
    UI.icpStateLbl.TextColor3 = hex(S.icpOn and S.theme.ok or S.theme.sub)
  end
end

function UI.renderIcpRules()
  local container = UI.icpRulesBox
  if not container then return end
  for _, c in ipairs(container:GetChildren()) do
    if c:IsA('Frame') or c:IsA('TextLabel') then c:Destroy() end
  end
  if #S.icp == 0 then
    text(container, {
      Size = UDim2.new(1, 0, 0, 30), BackgroundTransparency = 1,
      Text = 'Nenhuma regra. Adicione uma para bloquear URLs automaticamente.',
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11), TextWrapped = true, Parent = container,
    })
    return
  end
  for idx, rule in ipairs(S.icp) do
    local phase = rule.phase == 'response' and 'RESPONSE' or 'REQUEST'
    local rowH = math.max(40, btnH() + 8)
    local row = box(container, {
      Size = UDim2.new(1, 0, 0, rowH), BackgroundColor3 = S.theme.surface,
      BackgroundTransparency = 0.15, BorderSizePixel = 0, LayoutOrder = idx, Parent = container,
    })
    corner(row, 4); stroke(row, S.theme.border, 1)
    text(row, {
      Size = UDim2.new(1, -140, 0, 18), Position = UDim2.new(0, 8, 0, 3),
      BackgroundTransparency = 1, Text = rule.url ~= '' and shortUrl(rule.url) or '(todas as URLs)',
      TextColor3 = S.theme.text, Font = Enum.Font.Code, TextSize = fs(11),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = row,
    })
    text(row, {
      Size = UDim2.new(1, -140, 0, 14), Position = UDim2.new(0, 8, 0, 21),
      BackgroundTransparency = 1, Text = (rule.method or 'ANY') .. ' · ' .. phase .. ' · Bloquear',
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(10),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = row,
    })
    local edit = mkBtn(row, '✎', 26, S.theme.raised)
    edit.Position = UDim2.new(1, -84, 0, 7)
    local del = mkBtn(row, '✕', 26, S.theme.raised)
    del.Position = UDim2.new(1, -52, 0, 7)
    local tog = mkToggle(row, rule.enabled ~= false)
    tog.frame.Position = UDim2.new(1, -26, 0, 11)
    tog.cbs[#tog.cbs + 1] = function(on)
      S.icp[idx].enabled = on; saveIcp(); UI.pushToInterceptor()
    end
    edit.MouseButton1Click:Connect(function() UI.openIcpModal(idx) end)
    del.MouseButton1Click:Connect(function()
      table.remove(S.icp, idx); saveIcp(); UI.pushToInterceptor(); UI.renderIcpRules()
    end)
  end
end

-- ── Config ──
function UI.buildConfig(pg)
  local sc = new('ScrollingFrame', {
    Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0,
    CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 5, ScrollBarImageColor3 = S.theme.border2, Parent = pg,
  })
  vlist(sc, 10); pad(sc, 12, 12, 12, 12)

  local function heading(t)
    text(sc, {
      Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1, Text = t,
      TextColor3 = S.theme.accent, Font = Enum.Font.Code, TextSize = fs(12),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = sc,
    })
  end

  heading('Filters')
  local fRow = box(sc, { Size = UDim2.new(1, 0, 0, 26), BackgroundTransparency = 1, Parent = sc })
  text(fRow, {
    Size = UDim2.new(1, -50, 1, 0), BackgroundTransparency = 1,
    Text = 'Esconder GETs 2xx limpos', TextColor3 = S.theme.text,
    Font = Enum.Font.Code, TextSize = fs(11), TextXAlignment = Enum.TextXAlignment.Left, Parent = fRow,
  })
  local togGet = mkToggle(fRow, S.filterGet)
  togGet.frame.Position = UDim2.new(1, -34, 0, 4)
  togGet.cbs[#togGet.cbs + 1] = function(on) S.filterGet = on; UI.renderList() end

  heading('History')
  local clr = mkBtn(sc, '🗑 Limpar histórico', 160, S.theme.raised)
  clr.MouseButton1Click:Connect(function()
    S.reqs = {}; S.cur = nil; persistHistoryNow(true)
    UI.detOv.Visible = false; UI.repOv.Visible = false
    UI.renderList()
  end)

  heading('Janela')
  local function mkRange(key, min, max, step, def, fmt)
    local row = box(sc, { Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, Parent = sc })
    local lbl = text(row, {
      Size = UDim2.new(0, 120, 1, 0), BackgroundTransparency = 1,
      Text = key .. ': ' .. tostring(S.theme[key] or def), TextColor3 = S.theme.sub,
      Font = Enum.Font.Code, TextSize = fs(10), TextXAlignment = Enum.TextXAlignment.Left, Parent = row,
    })
    local minus = mkBtn(row, '−', 24, S.theme.raised); minus.Position = UDim2.new(0, 120, 0, 0)
    local plus = mkBtn(row, '+', 24, S.theme.raised); plus.Position = UDim2.new(0, 148, 0, 0)
    local function upd(delta)
      local v = (tonumber(S.theme[key]) or def) + delta
      if v < min then v = min end
      if v > max then v = max end
      S.theme[key] = v
      lbl.Text = key .. ': ' .. (fmt and fmt(v) or tostring(v))
      saveTheme(); UI.applyTheme()
    end
    minus.MouseButton1Click:Connect(function() upd(-step) end)
    plus.MouseButton1Click:Connect(function() upd(step) end)
  end
  mkRange('wpOp', 0, 1, 0.05, 0.10, function(v) return string.format('%.2f', v) end)
  mkRange('wpBr', 0.2, 2, 0.1, 1.0, function(v) return string.format('%.2f', v) end)

  heading('Cores')
  local colorKeys = {
    { 'accent', 'Accent' }, { 'dim', 'Accent Dim' }, { 'bg', 'Background' },
    { 'surface', 'Surface' }, { 'raised', 'Raised' }, { 'border', 'Border' },
    { 'text', 'Text' }, { 'sub', 'Muted' },
  }
  local palette = {
    '#c8ff00', '#7a9900', '#080808', '#0f0f0f', '#161616', '#1e1e1e',
    '#e2e2e2', '#888888', '#ff3d3d', '#ffaa00', '#22cc66', '#00aaff', '#ff00aa', '#ffffff',
  }
  local grid = box(sc, { Size = UDim2.new(1, 0, 0, 0), BackgroundTransparency = 1, Parent = sc })
  vlist(grid, 4)
  for _, ck in ipairs(colorKeys) do
    local key, label = ck[1], ck[2]
    local row = box(grid, { Size = UDim2.new(1, 0, 0, 24), BackgroundTransparency = 1, Parent = grid })
    text(row, {
      Size = UDim2.new(0, 100, 1, 0), BackgroundTransparency = 1, Text = label,
      TextColor3 = S.theme.text, Font = Enum.Font.Code, TextSize = fs(10),
      TextXAlignment = Enum.TextXAlignment.Left, Parent = row,
    })
    local swatch = box(row, {
      Size = UDim2.new(0, 20, 0, 20), Position = UDim2.new(0, 104, 0, 2),
      BackgroundColor3 = hex(S.theme[key], Color3.new(1, 1, 1)), BorderSizePixel = 0, Parent = row,
    })
    corner(swatch, 4); stroke(swatch, S.theme.border2, 1)
    local idx = 1
    for i, p in ipairs(palette) do if p == S.theme[key] then idx = i end end
    local prev = mkBtn(row, '‹', 22, S.theme.raised); prev.Position = UDim2.new(0, 130, 0, 0)
    local nxt = mkBtn(row, '›', 22, S.theme.raised); nxt.Position = UDim2.new(0, 156, 0, 0)
    local function apply()
      S.theme[key] = palette[idx]
      swatch.BackgroundColor3 = hex(palette[idx])
      saveTheme(); UI.applyTheme()
    end
    prev.MouseButton1Click:Connect(function() idx = idx - 1; if idx < 1 then idx = #palette end; apply() end)
    nxt.MouseButton1Click:Connect(function() idx = idx + 1; if idx > #palette then idx = 1 end; apply() end)
  end

  local rst = mkBtn(sc, '↺ Resetar padrões', 160, S.theme.raised)
  rst.MouseButton1Click:Connect(function()
    for k, v in pairs(DT) do S.theme[k] = v end
    saveTheme(); UI.applyTheme(); UI.syncCfg()
  end)

  heading('Wallpaper')
  local _, wpBox = mkInput(sc, 'https://exemplo.com/bg.jpg', 28)
  wpBox.Text = S.theme.wpUrl or ''
  wpBox.FocusLost:Connect(function()
    S.theme.wpUrl = wpBox.Text
    saveTheme()
    if UI.wallpaper then
      if wpBox.Text ~= '' then
        pcall(function()
          UI.wallpaper.Image = wpBox.Text
          UI.wallpaper.ImageTransparency = 1 - (tonumber(S.theme.wpOp) or 0.10)
        end)
      end
    end
  end)
end

function UI.syncCfg()
  -- mantém campos sincronizados (chamado ao abrir a aba)
end

function UI.applyTheme()
  if UI.root then UI.root.BackgroundColor3 = hex(S.theme.bg) end
  if UI.badge then UI.badge.BackgroundColor3 = hex(S.theme.accent) end
end

-- ── Painel de regras de substituição (aba Receive) ──
function UI.buildRulesPanel(pg)
  -- Painel ancorado no rodapé da página Receive. Em telas pequenas ele é a
  -- única forma de criar regras, então garantimos que fique visível.
  local list = pg:FindFirstChildOfClass('ScrollingFrame')
  if list then
    list.Size = UDim2.new(1, 0, 1, -30)
  end
  local panel = box(pg, {
    Size = UDim2.new(1, 0, 0, 30), Position = UDim2.new(0, 0, 1, -30),
    BackgroundColor3 = S.theme.surface, BackgroundTransparency = 0.1,
    BorderSizePixel = 0, ZIndex = 5, Parent = pg,
  })
  local toggle = button(panel, {
    Size = UDim2.new(1, -40, 0, 30), Position = UDim2.new(0, 0, 0, 0),
    BackgroundTransparency = 1, Text = '', BorderSizePixel = 0, ZIndex = 6, Parent = panel,
  })
  local chev = text(toggle, {
    Size = UDim2.new(1, -10, 1, 0), Position = UDim2.new(0, 10, 0, 0),
    BackgroundTransparency = 1, Text = '▶ Condições de substituição', TextColor3 = S.theme.accent,
    Font = Enum.Font.Code, TextSize = fs(12), TextScaled = isCompact(),
    TextXAlignment = Enum.TextXAlignment.Left, ZIndex = 7, Parent = toggle,
  })
  -- Botão de adicionar: alvo de toque maior no mobile.
  local addW = isCompact() and 34 or 28
  local addBtn = mkBtn(panel, '＋', addW, S.theme.accent)
  addBtn.TextColor3 = hex(S.theme.bg)
  addBtn.Position = UDim2.new(1, -(addW + 6), 0, 2); addBtn.ZIndex = 7

  local bodyWrap = new('ScrollingFrame', {
    Size = UDim2.new(1, 0, 0, 0), Position = UDim2.new(0, 0, 0, 30),
    BackgroundTransparency = 1, BorderSizePixel = 0, Visible = false, ZIndex = 6,
    CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 4, ScrollBarImageColor3 = S.theme.border2, Parent = panel,
  })
  local inner = box(bodyWrap, { Size = UDim2.new(1, -6, 0, 0), BackgroundTransparency = 1, Parent = bodyWrap })
  vlist(inner, 4); pad(inner, 8, 8, 4, 8)
  UI.rulesInner = inner

  local open = false
  local function setOpen(v)
    open = v
    bodyWrap.Visible = v
    chev.Text = (v and '▼ ' or '▶ ') .. 'Condições de substituição'
    local rowH = isCompact() and 40 or 44
    -- Limita a altura para o painel nunca estourar a tela (o corpo rola).
    local maxH = math.max(select(2, viewportSize()) - 120, 120)
    local h = v and math.min(30 + #S.rules * rowH + 20, maxH) or 30
    panel.Size = UDim2.new(1, 0, 0, h)
    panel.Position = UDim2.new(0, 0, 1, -h)
    if list then list.Size = UDim2.new(1, 0, 1, -h) end
  end
  toggle.MouseButton1Click:Connect(function() setOpen(not open) end)
  addBtn.MouseButton1Click:Connect(function() UI.openRuleModal() end)
  UI.rulesSetOpen = setOpen
  setOpen(false)
end

function UI.renderRules()
  local container = UI.rulesInner
  if not container then return end
  for _, c in ipairs(container:GetChildren()) do
    if c:IsA('Frame') or c:IsA('TextLabel') then c:Destroy() end
  end
  if #S.rules == 0 then
    text(container, {
      Size = UDim2.new(1, 0, 0, 24), BackgroundTransparency = 1,
      Text = 'Nenhuma condição — adicione uma para substituir no tráfego.',
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(10), TextWrapped = true, Parent = container,
    })
    return
  end
  for idx, rule in ipairs(S.rules) do
    local modeTag = rule.mode == 'var' and '{}' or 'Aa'
    local row = box(container, {
      Size = UDim2.new(1, 0, 0, 40), BackgroundColor3 = S.theme.bg,
      BackgroundTransparency = 0.2, BorderSizePixel = 0, LayoutOrder = idx, Parent = container,
    })
    corner(row, 4); stroke(row, S.theme.border, 1)
    text(row, {
      Size = UDim2.new(1, -110, 0, 18), Position = UDim2.new(0, 6, 0, 3),
      BackgroundTransparency = 1, Text = modeTag .. ' ' .. rule.find,
      TextColor3 = S.theme.text, Font = Enum.Font.Code, TextSize = fs(10),
      TextXAlignment = Enum.TextXAlignment.Left, TextTruncate = Enum.TextTruncate.AtEnd, Parent = row,
    })
    text(row, {
      Size = UDim2.new(1, -110, 0, 14), Position = UDim2.new(0, 6, 0, 21),
      BackgroundTransparency = 1, Text = '→ ' .. tostring(rule.replace),
      TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(10),
      TextXAlignment = Enum.TextXAlignment.Left, TextTruncate = Enum.TextTruncate.AtEnd, Parent = row,
    })
    local edit = mkBtn(row, '✎', 24, S.theme.raised); edit.Position = UDim2.new(1, -80, 0, 8)
    local del = mkBtn(row, '✕', 24, S.theme.raised); del.Position = UDim2.new(1, -52, 0, 8)
    local tog = mkToggle(row, rule.enabled ~= false); tog.frame.Position = UDim2.new(1, -26, 0, 11)
    tog.cbs[#tog.cbs + 1] = function(on)
      S.rules[idx].enabled = on; saveRules(); UI.pushToInterceptor()
    end
    edit.MouseButton1Click:Connect(function() UI.openRuleModal(idx) end)
    del.MouseButton1Click:Connect(function()
      table.remove(S.rules, idx); saveRules(); UI.pushToInterceptor(); UI.renderRules()
    end)
  end
end

-- ── Modais (rule de substituição + regra de bloqueio) ──
-- Largura responsiva: nunca maior que a tela (com margem). Em telas estreitas
-- os botões ficam empilhados para não estourar a largura.
local function modalWidth()
  local vw = viewportSize()
  return math.max(math.min(420, vw - SCREEN_MARGIN * 2), 220)
end

local function mkModal(parent, title, fields)
  local bg = box(parent, {
    Size = UDim2.new(1, 0, 1, 0), BackgroundColor3 = Color3.fromRGB(0, 0, 0),
    BackgroundTransparency = 0.4, BorderSizePixel = 0, Visible = false, ZIndex = 40, Parent = parent,
  })
  local mw = modalWidth()
  local modal = box(bg, {
    Size = UDim2.new(0, mw, 0, 0), Position = UDim2.new(0.5, -mw / 2, 0.5, 0),
    BackgroundColor3 = S.theme.bg, BorderSizePixel = 0, ZIndex = 41, Parent = bg,
  })
  corner(modal, 8); stroke(modal, S.theme.border2, 1)
  -- Corpo rolável: se o conteúdo não couber na tela, o usuário rola até o
  -- botão Salvar (nunca fica inacessível).
  local inner = new('ScrollingFrame', {
    Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1, BorderSizePixel = 0, ZIndex = 42,
    CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 5, ScrollBarImageColor3 = S.theme.border2, Parent = modal,
  })
  vlist(inner, 8); pad(inner, 12, 12, 12, 12)

  -- Soma determinística da altura do conteúdo. AbsoluteContentSize retorna 0
  -- na leitura síncrona no Roblox, então não dá para depender dele para medir.
  local contentH = 0
  local function addH(h) contentH = contentH + h end

  local titleLbl = text(inner, {
    Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1, Text = title,
    TextColor3 = S.theme.accent, Font = Enum.Font.Code, TextSize = fs(14),
    TextXAlignment = Enum.TextXAlignment.Left, TextWrapped = true, Parent = inner,
  })
  addH(20)

  local refs = {}
  for _, f in ipairs(fields) do
    if f.type == 'label' then
      text(inner, {
        Size = UDim2.new(1, 0, 0, 16), BackgroundTransparency = 1, Text = f.text,
        TextColor3 = S.theme.sub, Font = Enum.Font.Code, TextSize = fs(11),
        TextXAlignment = Enum.TextXAlignment.Left, Parent = inner,
      })
      addH(16)
    elseif f.type == 'input' then
      local ih = math.max(f.h or 28, btnH())
      local _, tb = mkInput(inner, f.placeholder, ih)
      tb.MultiLine = f.multiline or false
      refs[f.id] = tb
      addH(ih)
    elseif f.type == 'buttons' then
      -- Botões de opção em linha; quebram para a linha seguinte se não couberem.
      local bar = box(inner, { Size = UDim2.new(1, 0, 0, btnH()), BackgroundTransparency = 1, Parent = inner })
      hlist(bar, 6)
      refs[f.id] = {}
      for _, b in ipairs(f.options) do
        local bw = math.min(b.w or 90, mw - 40)
        local btn = mkBtn(bar, b.label, bw, b.color or S.theme.raised)
        btn.TextSize = fs(12)
        if b.accent then btn.TextColor3 = hex(S.theme.bg) end
        refs[f.id][b.value] = btn
      end
      addH(btnH())
    end
  end

  -- Em telas estreitas empilha os botões de ação (largura total) para que
  -- "Salvar" nunca fique fora da tela — que é o que impedia de criar regras.
  local bh = btnH()
  local stacked = isCompact()
  local barH = stacked and (bh * 2 + 6) or (bh + 4)
  local bar = box(inner, { Size = UDim2.new(1, 0, 0, barH), BackgroundTransparency = 1, Parent = inner })
  if stacked then
    vlist(bar, 6)
  else
    hlist(bar, 8)
  end
  local cancel = mkBtn(bar, '✕ Cancelar', stacked and 0 or 100, S.theme.raised)
  local save = mkBtn(bar, '✓ Salvar', stacked and 0 or 100, S.theme.accent)
  if stacked then
    cancel.Size = UDim2.new(1, 0, 0, bh)
    save.Size = UDim2.new(1, 0, 0, bh)
  end
  save.TextColor3 = hex(S.theme.bg)
  refs.__cancel = cancel
  refs.__save = save
  addH(barH)

  -- Altura do modal: conteúdo + gaps do UIListLayout + paddings, limitada à tela.
  local function fit()
    local _, vh = viewportSize()
    local n = #fields + 2 -- título + campos + barra de ações
    local h = contentH + 8 * (n - 1) + 24
    h = math.min(h, vh - SCREEN_MARGIN * 2)
    h = math.max(h, 140)
    modal.Size = UDim2.new(0, mw, 0, h)
  end
  refs.__fit = fit
  fit()

  return bg, modal, refs, titleLbl
end

local ruleModalState = { editIdx = nil, mode = 'case', get = true, post = true, deep = false }
local icpModalState = { editIdx = nil, method = 'ANY', phase = 'request' }

local function selectOption(refs, group, value)
  for v, btn in pairs(refs[group]) do
    local on = v == value
    btn.BackgroundColor3 = hex(on and S.theme.accent or S.theme.raised)
    btn.TextColor3 = hex(on and S.theme.bg or S.theme.text)
  end
end

-- Scope (GET/POST) é multi-seleção: cada botão alterna o seu próprio flag.
local function syncScope(refs)
  for v, btn in pairs(refs.scope) do
    local on = (v == 'get' and ruleModalState.get) or (v == 'post' and ruleModalState.post)
    btn.BackgroundColor3 = hex(on and S.theme.accent or S.theme.raised)
    btn.TextColor3 = hex(on and S.theme.bg or S.theme.text)
  end
end

local function syncDeep(refs)
  local btn = refs.deep.deep
  local on = ruleModalState.deep
  btn.BackgroundColor3 = hex(on and S.theme.accent or S.theme.raised)
  btn.TextColor3 = hex(on and S.theme.bg or S.theme.text)
end

function UI.buildModals(parent)
  -- Modal de condição de substituição
  local rbg, rmodal, rrefs = mkModal(parent, 'Nova condição', {
    { type = 'buttons', id = 'mode', options = {
      { label = 'Aa texto', value = 'case', w = 90 }, { label = '{} variável', value = 'var', w = 90 } } },
    { type = 'label', text = 'Find' },
    { type = 'input', id = 'find', placeholder = 'ex: "success": false' },
    { type = 'label', text = 'Replace' },
    { type = 'input', id = 'replace', placeholder = 'ex: "success": true' },
    { type = 'buttons', id = 'scope', options = {
      { label = 'GET', value = 'get', w = 70 }, { label = 'POST', value = 'post', w = 70 } } },
    { type = 'buttons', id = 'deep', options = { { label = 'Busca profunda', value = 'deep', w = 130 } } },
  })
  UI.ruleModalBg = rbg
  UI.ruleModalRefs = rrefs
  UI.ruleModalTitle = rmodal
  rrefs.__cancel.MouseButton1Click:Connect(function() rbg.Visible = false end)
  rrefs.__save.MouseButton1Click:Connect(function() UI.saveRuleFromModal() end)
  -- Callbacks conectados UMA vez (evita acúmulo de conexões a cada abertura).
  rrefs.mode.case.MouseButton1Click:Connect(function()
    ruleModalState.mode = 'case'; selectOption(rrefs, 'mode', 'case')
  end)
  rrefs.mode.var.MouseButton1Click:Connect(function()
    ruleModalState.mode = 'var'; selectOption(rrefs, 'mode', 'var')
  end)
  rrefs.scope.get.MouseButton1Click:Connect(function()
    ruleModalState.get = not ruleModalState.get; syncScope(rrefs)
  end)
  rrefs.scope.post.MouseButton1Click:Connect(function()
    ruleModalState.post = not ruleModalState.post; syncScope(rrefs)
  end)
  rrefs.deep.deep.MouseButton1Click:Connect(function()
    ruleModalState.deep = not ruleModalState.deep; syncDeep(rrefs)
  end)

  -- Modal de regra de bloqueio
  local ibg, imodal, irefs = mkModal(parent, 'Nova regra de bloqueio', {
    { type = 'label', text = 'URL (substring, vazio = todas)' },
    { type = 'input', id = 'url', placeholder = 'ex: /api/reward' },
    { type = 'label', text = 'Método' },
    { type = 'buttons', id = 'method', options = {
      { label = 'ANY', value = 'ANY', w = 60 }, { label = 'GET', value = 'GET', w = 60 },
      { label = 'POST', value = 'POST', w = 60 }, { label = 'PUT', value = 'PUT', w = 60 } } },
    { type = 'label', text = 'Fase' },
    { type = 'buttons', id = 'phase', options = {
      { label = 'REQUEST', value = 'request', w = 100 }, { label = 'RESPONSE', value = 'response', w = 100 } } },
  })
  UI.icpModalBg = ibg
  UI.icpModalRefs = irefs
  UI.icpModalTitle = imodal
  irefs.__cancel.MouseButton1Click:Connect(function() ibg.Visible = false end)
  irefs.__save.MouseButton1Click:Connect(function() UI.saveIcpFromModal() end)
  for _, m in ipairs({ 'ANY', 'GET', 'POST', 'PUT' }) do
    irefs.method[m].MouseButton1Click:Connect(function()
      icpModalState.method = m; selectOption(irefs, 'method', m)
    end)
  end
  for _, ph in ipairs({ 'request', 'response' }) do
    irefs.phase[ph].MouseButton1Click:Connect(function()
      icpModalState.phase = ph; selectOption(irefs, 'phase', ph)
    end)
  end
end

function UI.openRuleModal(editIdx)
  if not UI.ruleModalBg then return end
  local isEdit = type(editIdx) == 'number'
  local rule = isEdit and S.rules[editIdx] or
    { find = '', replace = '', enabled = true, mode = 'case', applyGet = true, applyPost = true, deepSearch = false }
  ruleModalState.editIdx = isEdit and editIdx or nil
  ruleModalState.mode = rule.mode or 'case'
  ruleModalState.get = rule.applyGet ~= false
  ruleModalState.post = rule.applyPost ~= false
  ruleModalState.deep = rule.deepSearch and true or false

  local r = UI.ruleModalRefs
  UI.ruleModalTitle.Text = isEdit and 'Editar condição' or 'Nova condição'
  r.find.Text = rule.find or ''
  r.replace.Text = rule.replace or ''
  r.__save.Text = isEdit and '✓ Salvar' or '✓ Adicionar'

  selectOption(r, 'mode', ruleModalState.mode)
  syncScope(r)
  syncDeep(r)
  if r.__fit then r.__fit() end
  UI.ruleModalBg.Visible = true
end

function UI.saveRuleFromModal()
  local r = UI.ruleModalRefs
  local find = r.find.Text
  if find == '' then UI.toast('Campo Find não pode ser vazio', 'err'); return end
  local newRule = {
    find = find, replace = r.replace.Text, mode = ruleModalState.mode,
    applyGet = ruleModalState.get, applyPost = ruleModalState.post,
    deepSearch = ruleModalState.deep, enabled = true,
  }
  if ruleModalState.editIdx then
    newRule.enabled = S.rules[ruleModalState.editIdx].enabled
    S.rules[ruleModalState.editIdx] = newRule
  else
    S.rules[#S.rules + 1] = newRule
  end
  saveRules(); UI.pushToInterceptor(); UI.renderRules()
  UI.ruleModalBg.Visible = false
  UI.toast(ruleModalState.editIdx and 'Condição atualizada' or 'Condição adicionada', 'ok')
end

function UI.openIcpModal(editIdx)
  if not UI.icpModalBg then return end
  local isEdit = type(editIdx) == 'number'
  local rule = isEdit and S.icp[editIdx] or { url = '', method = 'ANY', phase = 'request', enabled = true }
  icpModalState.editIdx = isEdit and editIdx or nil
  icpModalState.method = rule.method or 'ANY'
  icpModalState.phase = rule.phase or 'request'

  local r = UI.icpModalRefs
  UI.icpModalTitle.Text = isEdit and 'Editar regra de bloqueio' or 'Nova regra de bloqueio'
  r.url.Text = rule.url or ''
  r.__save.Text = isEdit and '✓ Salvar' or '✓ Adicionar'
  selectOption(r, 'method', icpModalState.method)
  selectOption(r, 'phase', icpModalState.phase)
  if r.__fit then r.__fit() end
  UI.icpModalBg.Visible = true
end

function UI.saveIcpFromModal()
  local r = UI.icpModalRefs
  local newRule = {
    url = r.url.Text, method = icpModalState.method,
    phase = icpModalState.phase, enabled = true,
  }
  if icpModalState.editIdx then
    newRule.enabled = S.icp[icpModalState.editIdx].enabled
    S.icp[icpModalState.editIdx] = newRule
  else
    S.icp[#S.icp + 1] = newRule
  end
  saveIcp(); UI.pushToInterceptor(); UI.renderIcpRules()
  UI.icpModalBg.Visible = false
  UI.toast(icpModalState.editIdx and 'Regra atualizada' or 'Regra adicionada', 'ok')
end

-- ── Envia regras/config ao interceptor ──
function UI.pushToInterceptor()
  Intercept.icp = S.icp
  Intercept.blocked = S.blocked
  Intercept.enabled = S.icpOn
  Intercept.holdReq = S.icpHoldReq
  Intercept.holdRes = S.icpHoldRes
  Rules.setFromUI(S.rules)
end

-- ── Toast ──
function UI.toast(msg, kind)
  if not UI.gui then return end
  local color = kind == 'ok' and S.theme.ok or S.theme.danger
  local vw = select(1, viewportSize())
  local tw2 = math.min(260, vw - 24)
  local t = text(UI.gui, {
    Size = UDim2.new(0, tw2, 0, 30), Position = UDim2.new(1, -(tw2 + 12), 1, -100),
    BackgroundColor3 = S.theme.raised, Text = msg, TextColor3 = color,
    Font = Enum.Font.Code, TextSize = fs(12), TextTruncate = Enum.TextTruncate.AtEnd,
    ZIndex = 100, Parent = UI.gui,
  })
  corner(t, 5); stroke(t, color, 1)
  local tw = game:GetService('TweenService')
  local canTween = tw and tw.Create
  if canTween then
    t.TextTransparency = 1
    pcall(function() tw:Create(t, TweenInfo.new(0.14), { TextTransparency = 0 }):Play() end)
  end
  delay(2.4, function()
    if canTween then
      pcall(function() tw:Create(t, TweenInfo.new(0.14), { TextTransparency = 1 }):Play() end)
    end
    delay(0.2, function() if t then t:Destroy() end end)
  end)
end

-- ── Minimizar / orb ──
function UI.setMin(n)
  S.minState = n
  saveMinState()
  local root, orb = UI.root, UI.orb
  if not root or not orb then return end
  if n == 0 then
    orb.Visible = false
    root.Visible = true
    local w, h = rootDims()
    UI.rootW, UI.rootH = w, h
    root.Size = UDim2.new(0, w, 0, h)
    local px, py = clampPos(S.pos.x, S.pos.y, w, h)
    root.Position = UDim2.new(0, px, 0, py)
    return
  end
  if n == 1 then
    orb.Visible = false
    root.Visible = true
    local w = math.min(260, select(1, viewportSize()) - SCREEN_MARGIN * 2)
    local h = math.min(300, select(2, viewportSize()) - SCREEN_MARGIN * 2)
    root.Size = UDim2.new(0, w, 0, h)
    return
  end
  root.Visible = false
  orb.Visible = true
end

-- ── Drag do painel e do orb ──
function UI.installDrag(root, hdr)
  local dragging, dragStart, startPos = false, nil, nil
  hdr.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1
      or input.UserInputType == Enum.UserInputType.Touch then
      dragging = true
      dragStart = input.Position
      startPos = root.Position
    end
  end)
  hdr.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1
      or input.UserInputType == Enum.UserInputType.Touch then
      dragging = false
      S.pos = { x = root.Position.X.Offset, y = root.Position.Y.Offset }
      savePos()
    end
  end)
  UserInputService.InputChanged:Connect(function(input)
    if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement
      or input.UserInputType == Enum.UserInputType.Touch) then
      local delta = input.Position - dragStart
      root.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X,
        startPos.Y.Scale, startPos.Y.Offset + delta.Y)
    end
  end)
end

function UI.installOrbDrag(orb, click)
  local dragging, dragStart, startPos, moved = false, nil, nil, false
  orb.InputBegan:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1
      or input.UserInputType == Enum.UserInputType.Touch then
      dragging = true; moved = false
      dragStart = input.Position; startPos = orb.Position
    end
  end)
  orb.InputEnded:Connect(function(input)
    if input.UserInputType == Enum.UserInputType.MouseButton1
      or input.UserInputType == Enum.UserInputType.Touch then
      dragging = false
      if moved then
        S.orbPos = { x = orb.Position.X.Offset, y = orb.Position.Y.Offset }
        saveOrbPos()
      end
    end
  end)
  UserInputService.InputChanged:Connect(function(input)
    if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement
      or input.UserInputType == Enum.UserInputType.Touch) then
      local delta = input.Position - dragStart
      if math.abs(delta.X) > 3 or math.abs(delta.Y) > 3 then moved = true end
      orb.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + delta.X,
        startPos.Y.Scale, startPos.Y.Offset + delta.Y)
    end
  end)
end

-- ═══════════════════════════════════════════════════════════
-- INSTALAÇÃO DOS HOOKS DE HTTP (executor / HttpService / game)
-- ═══════════════════════════════════════════════════════════

local function wrapCallable(holder, key, kind, methodGetter, argsMapper)
  local orig = holder[key]
  if type(orig) ~= 'function' then return end
  if getrawmetatable and setreadonly then
    local mt = getrawmetatable(holder)
    if mt then pcall(setreadonly, mt, false) end
  end
  local function wrapper(...)
    local args = { ... }
    local method, url, headers, body = methodGetter(args)
    local status, stxt, rh, rb, blocked = Intercept.perform(method, url, headers, body, kind)
    if blocked then error('BurpImpure: requisição bloqueada', 0) end
    if argsMapper then return argsMapper(status, stxt, rh, rb, orig, args) end
    return rb
  end
  local ok = pcall(function() holder[key] = wrapper end)
  if not ok and hookfunction then
    pcall(hookfunction, orig, wrapper)
  end
end

local function installHooks()
  -- game:HttpGet / HttpPost / HttpRequest
  if type(game) == 'table' or type(game) == 'userdata' then
    wrapCallable(game, 'HttpGet', 'HttpGet',
      function(a)
        local i = (a[1] == game) and 2 or 1
        return 'GET', a[i], {}, nil
      end,
      function(status, stxt, rh, rb) return rb end)
    wrapCallable(game, 'HttpPost', 'HttpPost',
      function(a)
        local i = (a[1] == game) and 2 or 1
        return 'POST', a[i], {}, a[i + 1]
      end,
      function(status, stxt, rh, rb) return rb end)
  end

  -- HttpService:RequestAsync / GetAsync / PostAsync
  local okHS = pcall(function() return HttpService end)
  if okHS and HttpService then
    pcall(function()
      HttpService.RequestAsync = function(self, opts)
        opts = opts or {}
        local status, stxt, rh, rb, blocked =
          Intercept.perform(opts.Method or 'GET', opts.Url, opts.Headers or {}, opts.Body, 'RequestAsync')
        if blocked then error('BurpImpure: bloqueada', 0) end
        return { Success = true, StatusCode = status or 200, StatusMessage = stxt or '', Headers = rh or {}, Body = rb }
      end
    end)
    pcall(function()
      HttpService.GetAsync = function(self, url, ...)
        local status, stxt, rh, rb, blocked = Intercept.perform('GET', url, {}, nil, 'GetAsync')
        if blocked then error('BurpImpure: bloqueada', 0) end
        return rb
      end
    end)
    pcall(function()
      HttpService.PostAsync = function(self, url, body, ...)
        local status, stxt, rh, rb, blocked = Intercept.perform('POST', url, {}, body, 'PostAsync')
        if blocked then error('BurpImpure: bloqueada', 0) end
        return rb
      end
    end)
  end

  -- Função HTTP global do executor (request/http_request)
  if hasRequest then
    local wrapped = function(opts)
      opts = opts or {}
      local status, stxt, rh, rb, blocked =
        Intercept.perform(opts.Method or 'GET', opts.Url, opts.Headers or {}, opts.Body, 'request')
      if blocked then error('BurpImpure: bloqueada', 0) end
      return { StatusCode = status or 200, StatusMessage = stxt or '', Headers = rh or {}, Body = rb }
    end
    pcall(function()
      if type(request) == 'function' then request = wrapped end
      if type(http_request) == 'function' then http_request = wrapped end
      if type(syn) == 'table' then syn.request = wrapped end
      if type(http) == 'table' then http.request = wrapped end
      if genv then
        if genv.request then genv.request = wrapped end
        if genv.http_request then genv.http_request = wrapped end
      end
    end)
  end
end

-- ═══════════════════════════════════════════════════════════
-- BOOT
-- ═══════════════════════════════════════════════════════════

local function boot()
  UI.pushToInterceptor()

  -- A UI recebe os payloads capturados e mantém a fila de interceptação.
  Intercept.onCapture = function(p)
    if p.held then
      -- já tratado por onHeld; evita duplicar a captura no histórico
      return
    end
    addReq(p)
  end
  Intercept.onHeld = function(h)
    local item = {
      id = h.id, phase = h.phase or 'request',
      type = h.kind or 'http', method = string.upper(tostring(h.method or 'GET')),
      url = h.url or '', reqH = h.requestHeaders or {}, reqB = storeBody(h.requestPayload),
      resH = h.responseHeaders or {}, resB = storeBody(h.responsePayload),
      status = h.status, stxt = h.statusText or '', ts = h.timestamp or nowMs(),
    }
    local found = false
    for i, x in ipairs(S.held) do
      if x.id == item.id and x.phase == item.phase then S.held[i] = item; found = true; break end
    end
    if not found then table.insert(S.held, 1, item) end
    UI.renderHeld()
  end

  UI.build()
  UI.buildModals(UI.root)
  UI.renderRules()

  installHooks()

  -- Watchdog: reanexa a UI se algo a remover (sites que trocam a CoreGui).
  if RunService then
    RunService.Heartbeat:Connect(function()
      if UI.gui and not UI.gui.Parent then
        UI.gui.Parent = CoreGui
      end
    end)
  end

  -- Reajusta o layout ao girar a tela / redimensionar (celular).
  local cam = currentCamera()
  if cam and cam.GetPropertyChangedSignal then
    pcall(function()
      cam:GetPropertyChangedSignal('ViewportSize'):Connect(function()
        if UI.setMin then UI.setMin(S.minState or 0) end
      end)
    end)
  end
end

-- Executa em thread própria para não travar o executor.
if spawn then
  spawn(function()
    local ok, err = pcall(boot)
    if not ok then
      warn('[BurpImpure] erro no boot: ' .. tostring(err))
    end
  end)
else
  boot()
end

-- Expõe o controle via getgenv (para o usuário usar de fora, se quiser).
if genv then
  genv.BurpImpure = {
    state = S,
    intercept = Intercept,
    ui = UI,
    open = function() if UI.root then UI.root.Visible = true; if UI.orb then UI.orb.Visible = false end end end,
    close = function() if UI.root then UI.root.Visible = false; if UI.orb then UI.orb.Visible = true end end end,
  }
end

return true



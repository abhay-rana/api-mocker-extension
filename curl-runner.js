// cURL Runner — a standalone Postman-lite request runner living in its own tab.
// Paste a curl, edit it in a builder, Send (via the background service worker so
// CORS is bypassed and the page session is NOT used), and view the response.
// Reuses esc() and buildTree() from panel.js (loaded before this file).
(() => {
  'use strict';

  const TOKEN_FIELDS = ['token', 'access_token', 'accesstoken', 'jwt', 'id_token', 'idtoken', 'authtoken'];
  const RESP_TREE_LIMIT = 80_000;
  const RECENT_KEY = 'curl-recent';
  const VARS_KEY = 'curl-vars';
  const MAX_RECENT = 5;

  const root = document.getElementById('curlRunner');
  if (!root) return;

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    mode: 'empty',                 // 'empty' | 'builder'
    rawCurl: '',
    method: 'GET',
    url: '',
    headers: [],                   // { name, value, enabled, _auth? }
    bodyType: 'none',              // 'none' | 'json' | 'form' | 'raw'
    body: '',
    form: [],                      // { name, value, enabled } (x-www-form-urlencoded)
    params: [],                    // { name, value, enabled } (synced to URL query)
    auth: { type: 'none', token: '', user: '', pass: '', keyName: 'X-API-Key', keyValue: '' },
    activeTab: 'body',             // 'body' | 'headers' | 'params' | 'auth'
    respView: 'pretty',            // 'pretty' | 'raw'
    respTab: 'body',               // 'body' | 'headers'
    response: null,                // last response object
    sending: false,
    parseWarnings: [],
  };
  let vars = {};
  let recent = [];
  let built = false;

  // ── Persistence ─────────────────────────────────────────────────────────────
  function loadStored() {
    chrome.storage.local.get([RECENT_KEY, VARS_KEY], (r) => {
      recent = Array.isArray(r[RECENT_KEY]) ? r[RECENT_KEY] : [];
      vars = (r[VARS_KEY] && typeof r[VARS_KEY] === 'object') ? r[VARS_KEY] : {};
      if (built && state.mode === 'empty') renderRecent();
      updateVarsButton();
    });
  }
  function saveRecent() { chrome.storage.local.set({ [RECENT_KEY]: recent }); }
  function saveVars() { chrome.storage.local.set({ [VARS_KEY]: vars }); updateVarsButton(); }

  function pushRecent(req) {
    const sig = req.method + ' ' + req.url + ' ' + (req.body || '');
    recent = recent.filter((r) => (r.method + ' ' + r.url + ' ' + (r.body || '')) !== sig);
    recent.unshift(req);
    if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
    saveRecent();
  }

  // ── curl parsing ──────────────────────────────────────────────────────────
  function tokenizeCurl(input) {
    const s = input.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ').trim();
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;

      // ANSI-C quoting: $'...'
      if (s[i] === '$' && s[i + 1] === "'") {
        i += 2;
        let buf = '';
        const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < s.length) { buf += (map[s[i + 1]] != null ? map[s[i + 1]] : s[i + 1]); i += 2; }
          else { buf += s[i]; i++; }
        }
        i++;
        tokens.push(buf);
        continue;
      }

      let cur = '';
      while (i < s.length && !/\s/.test(s[i])) {
        const ch = s[i];
        if (ch === "'") {
          i++;
          while (i < s.length && s[i] !== "'") { cur += s[i]; i++; }
          i++;
        } else if (ch === '"') {
          i++;
          while (i < s.length && s[i] !== '"') {
            if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; }
            else { cur += s[i]; i++; }
          }
          i++;
        } else if (ch === '\\') {
          if (i + 1 < s.length) { cur += s[i + 1]; i += 2; } else i++;
        } else { cur += ch; i++; }
      }
      tokens.push(cur);
    }
    return tokens;
  }

  function isJsonish(s) {
    const t = (s || '').trim();
    if (!t) return false;
    if (t[0] !== '{' && t[0] !== '[') return false;
    try { JSON.parse(t); return true; } catch { return false; }
  }

  function parseCurl(input) {
    const warnings = [];
    let tokens = tokenizeCurl(input);
    if (tokens[0] && tokens[0].toLowerCase() === 'curl') tokens = tokens.slice(1);

    let method = null, url = null;
    const headers = [];
    const dataParts = [];
    let basicRaw = null, getFlag = false;

    const IGNORED_NOARG = new Set([
      '--compressed', '-k', '--insecure', '-L', '--location', '-s', '--silent',
      '-v', '--verbose', '-i', '--include', '-S', '--show-error', '-#', '--progress-bar',
      '-f', '--fail', '--http1.1', '--http2', '-g', '--globoff',
    ]);
    const IGNORED_ARG = new Set(['-o', '--output', '-w', '--write-out', '--retry', '--connect-timeout', '--max-time', '-m']);

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const next = () => tokens[++i];

      if (t === '-X' || t === '--request') method = (next() || '').toUpperCase();
      else if (t === '-H' || t === '--header') {
        const h = next() || '';
        const idx = h.indexOf(':');
        if (idx > -1) headers.push({ name: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true });
      }
      else if (t === '-A' || t === '--user-agent') headers.push({ name: 'User-Agent', value: next() || '', enabled: true });
      else if (t === '-e' || t === '--referer') headers.push({ name: 'Referer', value: next() || '', enabled: true });
      else if (t === '-b' || t === '--cookie') headers.push({ name: 'Cookie', value: next() || '', enabled: true });
      else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
        const d = next() || '';
        if (d.startsWith('@')) warnings.push('Unsupported: @file data ("' + d + '") — the panel has no filesystem access.');
        else dataParts.push(d);
      }
      else if (t === '--data-urlencode') dataParts.push(next() || '');
      else if (t === '--json') { const d = next() || ''; dataParts.push(d); headers.push({ name: 'Content-Type', value: 'application/json', enabled: true }); }
      else if (t === '-u' || t === '--user') basicRaw = next() || '';
      else if (t === '-F' || t === '--form') { warnings.push('Unsupported flag -F (multipart/file upload "' + (next() || '') + '") — the panel cannot read files.'); }
      else if (t === '-G' || t === '--get') getFlag = true;
      else if (t === '--url') url = next();
      else if (IGNORED_ARG.has(t)) next();
      else if (IGNORED_NOARG.has(t)) { /* ignore */ }
      else if (/^https?:\/\//i.test(t)) url = t;
      else if (!t.startsWith('-') && url == null) url = t;
      else if (t.startsWith('-')) warnings.push('Ignored unsupported flag: ' + t);
    }

    if (basicRaw != null) {
      let u = basicRaw.includes(':') ? basicRaw : basicRaw + ':';
      let b64;
      try { b64 = btoa(unescape(encodeURIComponent(u))); } catch { b64 = btoa(u); }
      headers.push({ name: 'Authorization', value: 'Basic ' + b64, enabled: true });
    }

    let body = '', bodyType = 'none';
    if (dataParts.length) {
      body = dataParts.join('&');
      if (getFlag && url) {
        url += (url.includes('?') ? '&' : '?') + body;
        body = '';
      } else {
        bodyType = isJsonish(body) ? 'json' : 'raw';
        if (!method) method = 'POST';
      }
    }
    if (!method) method = 'GET';

    return { method, url: url || '', headers, body, bodyType, warnings };
  }

  // ── Variable resolution ──────────────────────────────────────────────────
  const VAR_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;
  function resolveVars(str, missing) {
    if (str == null) return str;
    return String(str).replace(VAR_RE, (m, name) => {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
      if (!missing.includes(name)) missing.push(name);
      return m;
    });
  }

  // ── Auth → header sync (single source of truth: headers) ───────────────────
  function applyAuthToHeaders() {
    state.headers = state.headers.filter((h) => !h._auth);
    const a = state.auth;
    if (a.type === 'bearer' && a.token) {
      state.headers.push({ name: 'Authorization', value: 'Bearer ' + a.token, enabled: true, _auth: true });
    } else if (a.type === 'basic' && (a.user || a.pass)) {
      let b64;
      const raw = a.user + ':' + a.pass;
      try { b64 = btoa(unescape(encodeURIComponent(raw))); } catch { b64 = btoa(raw); }
      state.headers.push({ name: 'Authorization', value: 'Basic ' + b64, enabled: true, _auth: true });
    } else if (a.type === 'apikey' && a.keyName && a.keyValue) {
      state.headers.push({ name: a.keyName, value: a.keyValue, enabled: true, _auth: true });
    }
  }

  // ── URL ⇄ Params ────────────────────────────────────────────────────────
  function getParams() {
    const q = state.url.indexOf('?');
    if (q === -1) return [];
    const qs = state.url.slice(q + 1);
    if (!qs) return [];
    return qs.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
      return eq === -1
        ? { name: dec(pair), value: '', enabled: true }
        : { name: dec(pair.slice(0, eq)), value: dec(pair.slice(eq + 1)), enabled: true };
    });
  }
  // Write state.params back into the URL query string (and the URL input).
  function syncUrlFromParams() {
    const base = state.url.split('?')[0];
    const qs = state.params
      .filter((p) => p.enabled && p.name)
      .map((p) => encodeURIComponent(p.name) + '=' + encodeURIComponent(p.value))
      .join('&');
    state.url = qs ? base + '?' + qs : base;
    const urlInput = root.querySelector('#crUrl');
    if (urlInput) urlInput.value = state.url;
    root.querySelector('#crParamCount').textContent = state.params.filter((p) => p.enabled && p.name).length;
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Rendering
  // ════════════════════════════════════════════════════════════════════════
  function buildSkeleton() {
    root.innerHTML = `
      <!-- Variables overlay -->
      <div class="cr-vars-overlay cr-hidden" id="crVarsOverlay">
        <div class="cr-vars-modal">
          <div class="cr-vars-head">
            <span class="cr-vars-title">Global Variables</span>
            <span class="cr-vars-sub">Use <code>{{name}}</code> in URL, headers, or body</span>
            <button class="cr-icon-btn" id="crVarsClose" title="Close">✕</button>
          </div>
          <div class="cr-vars-list" id="crVarsList"></div>
          <button class="cr-btn cr-btn-ghost" id="crVarsAdd">+ Add variable</button>
        </div>
      </div>

      <!-- EMPTY STATE -->
      <div class="cr-empty" id="crEmpty">
        <div class="cr-empty-head">
          <div>
            <h1 class="cr-h1">cURL Runner</h1>
            <p class="cr-sub">Paste a cURL from your backend dev — headers, auth, and body parsed automatically.</p>
          </div>
          <button class="cr-btn cr-btn-ghost" id="crVarsBtn1"><span class="cr-vars-dot"></span> Variables <span id="crVarsCount1">0</span></button>
        </div>
        <div class="cr-label">CURL COMMAND</div>
        <textarea class="cr-curl-input" id="crCurlInput" spellcheck="false" placeholder="curl -X POST https://api.example.com/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{&quot;email&quot;: &quot;user@example.com&quot;, &quot;password&quot;: &quot;secret&quot;}'"></textarea>
        <div class="cr-empty-actions">
          <span class="cr-hint">GET · POST · PUT · DELETE · PATCH · headers · JSON body</span>
          <button class="cr-btn cr-btn-primary" id="crParseBtn">Parse &amp; Preview</button>
        </div>
        <div class="cr-prompt" id="crPrompt">
          <div class="cr-prompt-glyph">&gt;_</div>
          <div>Paste a cURL above to preview and send it</div>
        </div>
        <div class="cr-recent-wrap" id="crRecentWrap">
          <div class="cr-label">RECENT REQUESTS</div>
          <div class="cr-recent" id="crRecent"></div>
        </div>
      </div>

      <!-- BUILDER -->
      <div class="cr-builder cr-hidden" id="crBuilder">
        <div class="cr-pinned" id="crPinned">
          <span class="cr-pinned-glyph">&gt;_</span>
          <code class="cr-pinned-curl" id="crPinnedCurl"></code>
          <button class="cr-btn cr-btn-ghost cr-btn-sm" id="crEditBtn">Edit</button>
          <button class="cr-btn cr-btn-ghost cr-btn-sm" id="crVarsBtn2"><span class="cr-vars-dot"></span> Vars <span id="crVarsCount2">0</span></button>
        </div>

        <div class="cr-warn cr-hidden" id="crWarn"></div>

        <div class="cr-reqline">
          <select class="cr-method" id="crMethod">
            <option>GET</option><option>POST</option><option>PUT</option>
            <option>PATCH</option><option>DELETE</option><option>HEAD</option><option>OPTIONS</option>
          </select>
          <input class="cr-url" id="crUrl" spellcheck="false" placeholder="https://api.example.com/v1/…" />
          <div class="cr-copy-wrap">
            <button class="cr-btn cr-btn-ghost" id="crCopyBtn">Copy ▾</button>
            <div class="cr-copy-menu cr-hidden" id="crCopyMenu">
              <button data-copy="curl">Copy as cURL</button>
              <button data-copy="fetch">Copy as fetch</button>
            </div>
          </div>
          <button class="cr-btn cr-btn-primary cr-send" id="crSendBtn">Send</button>
        </div>

        <div class="cr-tabs" id="crTabs">
          <button class="cr-tab cr-tab--active" data-tab="body">Body</button>
          <button class="cr-tab" data-tab="headers">Headers <span class="cr-badge" id="crHdrCount">0</span></button>
          <button class="cr-tab" data-tab="params">Params <span class="cr-badge" id="crParamCount">0</span></button>
          <button class="cr-tab" data-tab="auth">Auth</button>
        </div>

        <div class="cr-panels">
          <!-- BODY -->
          <div class="cr-panel" data-panel="body">
            <div class="cr-bodytype" id="crBodyType">
              <button class="cr-chip" data-bt="json">JSON</button>
              <button class="cr-chip" data-bt="form">Form</button>
              <button class="cr-chip" data-bt="raw">Raw</button>
              <button class="cr-chip" data-bt="none">None</button>
              <div class="cr-flex"></div>
              <button class="cr-link" id="crFormatBtn">{ } Format JSON</button>
            </div>
            <textarea class="cr-body" id="crBody" spellcheck="false" placeholder="Request body…"></textarea>
            <div class="cr-kvlist cr-hidden" id="crFormList"></div>
            <button class="cr-link cr-add cr-hidden" id="crFormAdd">+ Add field</button>
          </div>
          <!-- HEADERS -->
          <div class="cr-panel cr-hidden" data-panel="headers">
            <div class="cr-kvlist" id="crHdrList"></div>
            <button class="cr-link cr-add" id="crHdrAdd">+ Add Header</button>
            <div class="cr-tip">Tip: use <code>{{variable}}</code> to reference global values in any field.</div>
          </div>
          <!-- PARAMS -->
          <div class="cr-panel cr-hidden" data-panel="params">
            <div class="cr-kvlist" id="crParamList"></div>
            <button class="cr-link cr-add" id="crParamAdd">+ Add Param</button>
          </div>
          <!-- AUTH -->
          <div class="cr-panel cr-hidden" data-panel="auth">
            <div class="cr-auth-row">
              <span class="cr-field-label">Type</span>
              <select class="cr-select" id="crAuthType">
                <option value="none">None</option>
                <option value="bearer">Bearer Token</option>
                <option value="basic">Basic Auth</option>
                <option value="apikey">API Key</option>
              </select>
            </div>
            <div class="cr-auth-fields" id="crAuthFields"></div>
          </div>
        </div>

        <!-- RESPONSE -->
        <div class="cr-response" id="crResponse"></div>
      </div>
    `;
    wireSkeleton();
    built = true;
  }

  // ── event wiring (once) ────────────────────────────────────────────────────
  function wireSkeleton() {
    const $ = (s) => root.querySelector(s);

    $('#crParseBtn').addEventListener('click', () => doParse($('#crCurlInput').value));
    $('#crEditBtn').addEventListener('click', () => switchMode('empty'));

    $('#crVarsBtn1').addEventListener('click', openVars);
    $('#crVarsBtn2').addEventListener('click', openVars);
    $('#crVarsClose').addEventListener('click', closeVars);
    $('#crVarsAdd').addEventListener('click', () => { addVarRow('', ''); });
    $('#crVarsOverlay').addEventListener('click', (e) => { if (e.target.id === 'crVarsOverlay') closeVars(); });

    $('#crMethod').addEventListener('change', (e) => { state.method = e.target.value; });
    $('#crUrl').addEventListener('input', (e) => { state.url = e.target.value; });
    $('#crUrl').addEventListener('blur', () => { if (state.activeTab === 'params') { state.params = getParams(); renderParams(); } });

    $('#crSendBtn').addEventListener('click', send);
    $('#crBody').addEventListener('input', (e) => { state.body = e.target.value; });
    $('#crFormatBtn').addEventListener('click', formatJson);

    // builder tabs
    $('#crTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.cr-tab'); if (!b) return;
      setActiveTab(b.dataset.tab);
    });
    // body type
    $('#crBodyType').addEventListener('click', (e) => {
      const b = e.target.closest('.cr-chip'); if (!b) return;
      setBodyType(b.dataset.bt);
    });

    // add buttons
    $('#crHdrAdd').addEventListener('click', () => { state.headers.push({ name: '', value: '', enabled: true }); renderHeaders(); focusLastRow('#crHdrList'); });
    $('#crParamAdd').addEventListener('click', () => { state.params.push({ name: '', value: '', enabled: true }); renderParams(); focusLastRow('#crParamList'); });
    $('#crFormAdd').addEventListener('click', () => { state.form.push({ name: '', value: '', enabled: true }); renderForm(); focusLastRow('#crFormList'); });

    // kv list delegation
    wireKvList('#crHdrList', () => state.headers, renderHeaders, () => { updateHdrCount(); });
    wireKvList('#crParamList', () => state.params, renderParams, syncUrlFromParams);
    wireKvList('#crFormList', () => state.form, renderForm);

    // auth
    $('#crAuthType').addEventListener('change', (e) => { state.auth.type = e.target.value; renderAuthFields(); applyAuthToHeaders(); updateHdrCount(); if (state.activeTab === 'headers') renderHeaders(); });
    $('#crAuthFields').addEventListener('input', (e) => {
      const f = e.target.dataset.authField; if (!f) return;
      state.auth[f] = e.target.value;
      applyAuthToHeaders(); updateHdrCount();
    });

    // copy menu
    $('#crCopyBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#crCopyMenu').classList.toggle('cr-hidden'); });
    $('#crCopyMenu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-copy]'); if (!b) return;
      doCopy(b.dataset.copy, b);
    });
    document.addEventListener('click', () => $('#crCopyMenu') && $('#crCopyMenu').classList.add('cr-hidden'));

    // recent delegation
    $('#crRecent').addEventListener('click', (e) => {
      const row = e.target.closest('.cr-recent-row'); if (!row) return;
      loadRecent(parseInt(row.dataset.idx, 10));
    });

    // response delegation (capture token / save-as-var / tabs / pretty-raw)
    $('#crResponse').addEventListener('click', onResponseClick);
  }

  // Generic key/value row list (headers, params, form). getList() returns the
  // backing array; rerender() rebuilds the rows; onChange() runs after any edit.
  function wireKvList(sel, getList, rerender, onChange) {
    const el = root.querySelector(sel);
    el.addEventListener('input', (e) => {
      const row = e.target.closest('.cr-kv'); if (!row) return;
      const list = getList();
      const item = list[parseInt(row.dataset.idx, 10)]; if (!item) return;
      if (e.target.classList.contains('cr-kv-name')) item.name = e.target.value;
      if (e.target.classList.contains('cr-kv-val')) item.value = e.target.value;
      if (onChange) onChange();
    });
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.cr-kv'); if (!row) return;
      const idx = parseInt(row.dataset.idx, 10);
      const list = getList();
      if (e.target.closest('.cr-kv-toggle')) {
        if (list[idx]) list[idx].enabled = !list[idx].enabled;
      } else if (e.target.closest('.cr-kv-del')) {
        list.splice(idx, 1);
      } else return;
      if (onChange) onChange();
      if (rerender) rerender();
    });
  }

  function focusLastRow(sel) {
    const rows = root.querySelectorAll(sel + ' .cr-kv');
    const last = rows[rows.length - 1];
    if (last) last.querySelector('.cr-kv-name').focus();
  }

  function kvRowsHtml(list) {
    if (!list.length) return '<div class="cr-kv-empty">No entries yet.</div>';
    return list.map((r, i) => `
      <div class="cr-kv${r.enabled ? '' : ' cr-kv--off'}" data-idx="${i}">
        <button class="cr-kv-toggle${r.enabled ? ' on' : ''}" title="Enable/disable"></button>
        <input class="cr-kv-name" placeholder="name" value="${esc(r.name)}" spellcheck="false" />
        <input class="cr-kv-val" placeholder="value" value="${esc(r.value)}" spellcheck="false" />
        <button class="cr-kv-del" title="Remove">✕</button>
      </div>`).join('');
  }

  function renderHeaders() { root.querySelector('#crHdrList').innerHTML = kvRowsHtml(state.headers); updateHdrCount(); }
  function renderForm() { root.querySelector('#crFormList').innerHTML = kvRowsHtml(state.form); }
  function renderParams() {
    root.querySelector('#crParamList').innerHTML = kvRowsHtml(state.params);
    root.querySelector('#crParamCount').textContent = state.params.filter((x) => x.enabled && x.name).length;
  }
  function updateHdrCount() {
    root.querySelector('#crHdrCount').textContent = state.headers.filter((h) => h.enabled && h.name).length;
  }

  function renderAuthFields() {
    const el = root.querySelector('#crAuthFields');
    const a = state.auth;
    if (a.type === 'bearer') {
      el.innerHTML = `<div class="cr-auth-row"><span class="cr-field-label">Token</span>
        <input class="cr-input" data-auth-field="token" placeholder="token or {{token}}" value="${esc(a.token)}" spellcheck="false"/></div>`;
    } else if (a.type === 'basic') {
      el.innerHTML = `<div class="cr-auth-row"><span class="cr-field-label">Username</span>
        <input class="cr-input" data-auth-field="user" value="${esc(a.user)}" spellcheck="false"/></div>
        <div class="cr-auth-row"><span class="cr-field-label">Password</span>
        <input class="cr-input" data-auth-field="pass" value="${esc(a.pass)}" spellcheck="false"/></div>`;
    } else if (a.type === 'apikey') {
      el.innerHTML = `<div class="cr-auth-row"><span class="cr-field-label">Header</span>
        <input class="cr-input" data-auth-field="keyName" value="${esc(a.keyName)}" spellcheck="false"/></div>
        <div class="cr-auth-row"><span class="cr-field-label">Value</span>
        <input class="cr-input" data-auth-field="keyValue" placeholder="key or {{apiKey}}" value="${esc(a.keyValue)}" spellcheck="false"/></div>`;
    } else {
      el.innerHTML = `<div class="cr-auth-none">No authentication. Add it here or via the Headers tab.</div>`;
    }
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    root.querySelectorAll('.cr-tab').forEach((b) => b.classList.toggle('cr-tab--active', b.dataset.tab === tab));
    root.querySelectorAll('.cr-panel').forEach((p) => p.classList.toggle('cr-hidden', p.dataset.panel !== tab));
    if (tab === 'headers') renderHeaders();
    if (tab === 'params') { state.params = getParams(); renderParams(); }
    if (tab === 'auth') renderAuthFields();
  }

  function setBodyType(bt) {
    state.bodyType = bt;
    root.querySelectorAll('#crBodyType .cr-chip').forEach((c) => c.classList.toggle('cr-chip--active', c.dataset.bt === bt));
    const ta = root.querySelector('#crBody');
    const formList = root.querySelector('#crFormList');
    const formAdd = root.querySelector('#crFormAdd');
    const fmt = root.querySelector('#crFormatBtn');
    const isForm = bt === 'form';
    const isNone = bt === 'none';
    ta.classList.toggle('cr-hidden', isForm || isNone);
    formList.classList.toggle('cr-hidden', !isForm);
    formAdd.classList.toggle('cr-hidden', !isForm);
    fmt.style.visibility = bt === 'json' ? 'visible' : 'hidden';
    if (isForm) renderForm();
  }

  function formatJson() {
    const ta = root.querySelector('#crBody');
    try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); state.body = ta.value; }
    catch { flash(root.querySelector('#crFormatBtn'), 'Invalid JSON'); }
  }

  // ── parse → builder ────────────────────────────────────────────────────────
  function doParse(text) {
    if (!text || !text.trim()) { flash(root.querySelector('#crParseBtn'), 'Paste a curl first'); return; }
    const parsed = parseCurl(text);
    state.rawCurl = text.trim();
    state.method = parsed.method;
    state.url = parsed.url;
    state.headers = parsed.headers;
    state.bodyType = parsed.bodyType;
    state.body = parsed.body;
    state.form = [];
    state.auth = { type: 'none', token: '', user: '', pass: '', keyName: 'X-API-Key', keyValue: '' };
    state.parseWarnings = parsed.warnings;
    state.response = null;
    populateBuilder();
    switchMode('builder');
  }

  function populateBuilder() {
    root.querySelector('#crPinnedCurl').textContent = state.rawCurl.replace(/\s*\\\s*\n\s*/g, ' ').replace(/\s+/g, ' ');
    root.querySelector('#crMethod').value = state.method;
    root.querySelector('#crUrl').value = state.url;
    root.querySelector('#crBody').value = state.body;
    setBodyType(state.bodyType);
    root.querySelector('#crAuthType').value = 'none';
    renderAuthFields();
    renderHeaders();
    state.params = getParams();
    renderParams();
    setActiveTab('body');
    renderResponse();

    const warn = root.querySelector('#crWarn');
    if (state.parseWarnings.length) {
      warn.classList.remove('cr-hidden');
      warn.innerHTML = state.parseWarnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('');
    } else {
      warn.classList.add('cr-hidden'); warn.innerHTML = '';
    }
  }

  function switchMode(mode) {
    state.mode = mode;
    root.querySelector('#crEmpty').classList.toggle('cr-hidden', mode !== 'empty');
    root.querySelector('#crBuilder').classList.toggle('cr-hidden', mode !== 'builder');
    if (mode === 'empty') renderRecent();
  }

  // ── Send ────────────────────────────────────────────────────────────────
  function buildSendHeaders(missing) {
    const out = {};
    for (const h of state.headers) {
      if (!h.enabled || !h.name.trim()) continue;
      out[resolveVars(h.name, missing)] = resolveVars(h.value, missing);
    }
    return out;
  }
  function buildSendBody(missing) {
    if (state.bodyType === 'none') return null;
    if (state.bodyType === 'form') {
      return state.form.filter((f) => f.enabled && f.name)
        .map((f) => encodeURIComponent(resolveVars(f.name, missing)) + '=' + encodeURIComponent(resolveVars(f.value, missing)))
        .join('&');
    }
    return resolveVars(state.body, missing);
  }

  async function send() {
    if (state.sending) return;
    const missing = [];
    const url = resolveVars(state.url, missing).trim();
    const headers = buildSendHeaders(missing);
    const body = buildSendBody(missing);

    if (missing.length) {
      state.response = { kind: 'error', error: 'Undefined variable' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '. Define ' + (missing.length > 1 ? 'them' : 'it') + ' in Variables.' };
      renderResponse();
      return;
    }
    if (!url) { flash(root.querySelector('#crSendBtn'), 'URL required'); return; }

    state.sending = true;
    const sendBtn = root.querySelector('#crSendBtn');
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    state.response = { kind: 'loading' };
    renderResponse();

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'RUN_REQUEST', payload: { method: state.method, url, headers, body } });
    } catch (e) {
      void chrome.runtime.lastError;
      res = { ok: false, error: 'Extension messaging error: ' + (e && e.message ? e.message : 'unknown') };
    }
    state.sending = false;
    sendBtn.disabled = false; sendBtn.textContent = 'Send';

    if (!res) res = { ok: false, error: 'No response from background.' };
    state.response = res.ok
      ? { kind: 'response', ...res }
      : { kind: 'error', error: res.error || 'Request failed.', elapsedMs: res.elapsedMs };
    renderResponse();

    // Save to recent (request only) regardless of outcome.
    pushRecent({
      method: state.method, url: state.url, headers: state.headers,
      bodyType: state.bodyType, body: state.body, form: state.form,
      rawCurl: state.rawCurl, auth: state.auth,
    });
  }

  // ── Response rendering ──────────────────────────────────────────────────
  function statusClass(s) { return s < 300 ? 'ok' : s < 400 ? 'redir' : s < 500 ? 'cli' : 'srv'; }
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function renderResponse() {
    const el = root.querySelector('#crResponse');
    const r = state.response;
    if (!r) { el.innerHTML = `<div class="cr-resp-idle"><span class="cr-prompt-glyph">&gt;_</span><span>Send the request to see the response.</span></div>`; return; }
    if (r.kind === 'loading') { el.innerHTML = `<div class="cr-resp-idle"><span class="cr-spinner"></span><span>Sending…</span></div>`; return; }
    if (r.kind === 'error') {
      el.innerHTML = `<div class="cr-resp-error">
        <div class="cr-resp-error-title">Request failed</div>
        <div class="cr-resp-error-msg">${esc(r.error)}</div>
        ${r.elapsedMs != null ? `<div class="cr-resp-error-meta">after ${r.elapsedMs} ms</div>` : ''}
      </div>`;
      return;
    }
    // success
    const sc = statusClass(r.status);
    const hdrCount = Object.keys(r.headers || {}).length;
    el.innerHTML = `
      <div class="cr-resp-bar">
        <span class="cr-status cr-status--${sc}">${r.status} ${esc(r.statusText || '')}</span>
        <span class="cr-resp-meta">${r.elapsedMs} ms</span>
        <span class="cr-resp-meta">${fmtSize(r.size)}</span>
        ${r.redirected ? '<span class="cr-resp-meta cr-resp-meta--dim">redirected</span>' : ''}
        <div class="cr-flex"></div>
        <button class="cr-link" data-resp-act="capture">Capture token</button>
        <button class="cr-link" data-resp-act="copy">Copy</button>
      </div>
      <div class="cr-resp-tabs">
        <button class="cr-rtab${state.respTab === 'body' ? ' cr-rtab--active' : ''}" data-rtab="body">Body</button>
        <button class="cr-rtab${state.respTab === 'headers' ? ' cr-rtab--active' : ''}" data-rtab="headers">Headers <span class="cr-badge">${hdrCount}</span></button>
        <div class="cr-flex"></div>
        <div class="cr-prettyraw${state.respTab === 'body' ? '' : ' cr-hidden'}">
          <button class="cr-seg${state.respView === 'pretty' ? ' cr-seg--active' : ''}" data-view="pretty">Pretty</button>
          <button class="cr-seg${state.respView === 'raw' ? ' cr-seg--active' : ''}" data-view="raw">Raw</button>
        </div>
      </div>
      <div class="cr-resp-body" id="crRespBody"></div>`;
    renderRespBody();
  }

  function renderRespBody() {
    const r = state.response;
    const el = root.querySelector('#crRespBody');
    if (!el || !r || r.kind !== 'response') return;
    if (state.respTab === 'headers') {
      const hs = r.headers || {};
      const keys = Object.keys(hs);
      el.innerHTML = keys.length
        ? `<div class="cr-hdr-table">${keys.map((k) => `<div class="cr-hdr-k">${esc(k)}</div><div class="cr-hdr-v">${esc(hs[k])}</div>`).join('')}</div>`
        : '<div class="cr-kv-empty">No response headers.</div>';
      return;
    }
    // body tab
    const raw = r.body || '';
    if (state.respView === 'raw') {
      el.innerHTML = `<pre class="cr-pre">${esc(raw)}</pre>`;
      return;
    }
    if (!raw.trim()) { el.innerHTML = '<span class="cr-empty-val">(empty body)</span>'; return; }
    if (raw.length > RESP_TREE_LIMIT) {
      el.innerHTML = `<div class="cr-resp-big">Response too large to render as a tree (${fmtSize(r.size)}). Showing raw.</div><pre class="cr-pre">${esc(raw.slice(0, 10000))}${raw.length > 10000 ? '\n… ' + fmtSize(raw.length - 10000) + ' more not shown' : ''}</pre>`;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { el.innerHTML = `<pre class="cr-pre">${esc(raw)}</pre>`; return; }
    el.innerHTML = buildRespTree(parsed, 0);
  }

  // Read-only JSON tree whose leaves carry their full value for save-as-variable.
  function buildRespTree(val, depth) {
    if (val === null) return leafHtml('null', null);
    const tp = typeof val;
    if (tp === 'boolean' || tp === 'number') return leafHtml(String(val), val);
    if (tp === 'string') return leafHtml('"' + (val.length > 200 ? esc(val.slice(0, 200)) + '…' : esc(val)) + '"', val, 'str');
    const open = depth < 1 ? 'open' : '';
    if (Array.isArray(val)) {
      if (!val.length) return '<span class="jbracket">[]</span>';
      const items = val.map((v, i) => `<div class="jrow"><span class="jindex">${i}</span><span class="jcolon">: </span>${buildRespTree(v, depth + 1)}</div>`).join('');
      return `<details class="jtree" ${open}><summary class="jsummary"><span class="jbracket">[</span><span class="jmeta">&nbsp;${val.length} item${val.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">]</span></summary><div class="jchildren">${items}</div></details>`;
    }
    const keys = Object.keys(val);
    if (!keys.length) return '<span class="jbracket">{}</span>';
    const items = keys.map((k) => `<div class="jrow"><span class="jkey">"${esc(k)}"</span><span class="jcolon">: </span>${buildRespTree(val[k], depth + 1)}</div>`).join('');
    return `<details class="jtree" ${open}><summary class="jsummary"><span class="jbracket">{</span><span class="jmeta">&nbsp;${keys.length} key${keys.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">}</span></summary><div class="jchildren">${items}</div></details>`;
  }
  function leafHtml(display, val, kind) {
    const cls = val === null ? 'jnull' : kind === 'str' ? 'jstr' : typeof val === 'number' ? 'jnum' : 'jbool';
    const enc = esc(JSON.stringify(val == null ? null : val));
    return `<span class="${cls} cr-leaf" data-val="${enc}" title="Click to save as variable">${display}</span>`;
  }

  function onResponseClick(e) {
    const act = e.target.closest('[data-resp-act]');
    if (act) {
      if (act.dataset.respAct === 'copy') copyText(state.response.body || '', act, 'Copied');
      if (act.dataset.respAct === 'capture') captureToken(act);
      return;
    }
    const rtab = e.target.closest('[data-rtab]');
    if (rtab) { state.respTab = rtab.dataset.rtab; renderResponse(); return; }
    const seg = e.target.closest('[data-view]');
    if (seg) { state.respView = seg.dataset.view; renderResponse(); return; }
    const leaf = e.target.closest('.cr-leaf');
    if (leaf) { saveLeafAsVar(leaf); return; }
  }

  function deepFindToken(obj) {
    if (obj == null) return null;
    if (Array.isArray(obj)) { for (const v of obj) { const f = deepFindToken(v); if (f) return f; } return null; }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (TOKEN_FIELDS.includes(k.toLowerCase()) && typeof obj[k] === 'string' && obj[k]) return obj[k];
      }
      for (const k of Object.keys(obj)) { const f = deepFindToken(obj[k]); if (f) return f; }
    }
    return null;
  }
  function captureToken(btn) {
    const r = state.response;
    let parsed;
    try { parsed = JSON.parse(r.body); } catch { flash(btn, 'Not JSON'); return; }
    const tok = deepFindToken(parsed);
    if (!tok) { flash(btn, 'No token field found'); return; }
    vars.token = tok; saveVars();
    flash(btn, 'Saved {{token}}');
  }
  function saveLeafAsVar(leaf) {
    let val;
    try { val = JSON.parse(leaf.dataset.val); } catch { val = leaf.textContent; }
    const name = window.prompt('Save this value as variable {{name}}:', '');
    if (!name) return;
    vars[name.trim()] = typeof val === 'string' ? val : String(val);
    saveVars();
    flash(leaf, 'Saved {{' + name.trim() + '}}');
  }

  // ── Copy as cURL / fetch ────────────────────────────────────────────────
  function escShellQ(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
  function genCurl() {
    const parts = [`curl -X ${state.method}`];
    for (const h of state.headers) { if (h.enabled && h.name) parts.push(`  -H ${escShellQ(h.name + ': ' + h.value)}`); }
    const body = buildSendBody([]);
    if (body) parts.push(`  --data ${escShellQ(body)}`);
    parts.push(`  ${escShellQ(state.url)}`);
    return parts.join(' \\\n');
  }
  function genFetch() {
    const headers = {};
    for (const h of state.headers) { if (h.enabled && h.name) headers[h.name] = h.value; }
    const init = { method: state.method };
    if (Object.keys(headers).length) init.headers = headers;
    const body = buildSendBody([]);
    if (body) init.body = body;
    return `fetch(${JSON.stringify(state.url)}, ${JSON.stringify(init, null, 2)})\n  .then(r => r.json())\n  .then(console.log);`;
  }
  function doCopy(kind, btn) {
    const text = kind === 'curl' ? genCurl() : genFetch();
    copyText(text, btn, 'Copied');
    root.querySelector('#crCopyMenu').classList.add('cr-hidden');
  }

  // ── Variables overlay ────────────────────────────────────────────────────
  function openVars() {
    renderVarsList();
    root.querySelector('#crVarsOverlay').classList.remove('cr-hidden');
  }
  function closeVars() { commitVars(); root.querySelector('#crVarsOverlay').classList.add('cr-hidden'); }
  function renderVarsList() {
    const el = root.querySelector('#crVarsList');
    const keys = Object.keys(vars);
    el.innerHTML = '';
    if (!keys.length) addVarRow('', '');
    else keys.forEach((k) => addVarRow(k, vars[k]));
  }
  function addVarRow(name, value) {
    const el = root.querySelector('#crVarsList');
    const row = document.createElement('div');
    row.className = 'cr-kv';
    row.innerHTML = `<input class="cr-kv-name" placeholder="name" value="${esc(name)}" spellcheck="false"/>
      <input class="cr-kv-val" placeholder="value" value="${esc(value)}" spellcheck="false"/>
      <button class="cr-kv-del" title="Remove">✕</button>`;
    row.querySelector('.cr-kv-del').addEventListener('click', () => { row.remove(); commitVars(); });
    el.appendChild(row);
  }
  function commitVars() {
    const next = {};
    root.querySelectorAll('#crVarsList .cr-kv').forEach((row) => {
      const n = row.querySelector('.cr-kv-name').value.trim();
      const v = row.querySelector('.cr-kv-val').value;
      if (n) next[n] = v;
    });
    vars = next; saveVars();
  }
  function updateVarsButton() {
    const n = Object.keys(vars).length;
    const a = root.querySelector('#crVarsCount1'); if (a) a.textContent = n;
    const b = root.querySelector('#crVarsCount2'); if (b) b.textContent = n;
  }

  // ── Recent ──────────────────────────────────────────────────────────────
  function renderRecent() {
    const wrap = root.querySelector('#crRecentWrap');
    const el = root.querySelector('#crRecent');
    if (!recent.length) { wrap.classList.add('cr-hidden'); return; }
    wrap.classList.remove('cr-hidden');
    el.innerHTML = recent.map((r, i) => `
      <div class="cr-recent-row" data-idx="${i}">
        <span class="cr-recent-method cr-recent-method--${statusMethodClass(r.method)}">${esc(r.method)}</span>
        <span class="cr-recent-url">${esc(r.url)}</span>
      </div>`).join('');
  }
  function statusMethodClass(m) {
    m = (m || '').toUpperCase();
    return m === 'GET' ? 'get' : m === 'POST' ? 'post' : m === 'DELETE' ? 'del' : m === 'PUT' || m === 'PATCH' ? 'put' : 'other';
  }
  function loadRecent(idx) {
    const r = recent[idx]; if (!r) return;
    state.method = r.method; state.url = r.url;
    state.headers = (r.headers || []).map((h) => ({ ...h }));
    state.bodyType = r.bodyType || 'none'; state.body = r.body || '';
    state.form = (r.form || []).map((f) => ({ ...f }));
    state.auth = r.auth ? { ...r.auth } : { type: 'none', token: '', user: '', pass: '', keyName: 'X-API-Key', keyValue: '' };
    state.rawCurl = r.rawCurl || genCurl();
    state.parseWarnings = [];
    state.response = null;            // T15: load only — no auto-send
    populateBuilder();
    switchMode('builder');
  }

  // ── small utils ───────────────────────────────────────────────────────────
  function copyText(text, btn, okMsg) {
    const done = () => flash(btn, okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta); done();
  }
  function flash(btn, msg) {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('cr-flash');
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('cr-flash'); }, 1100);
  }

  // ── public hook ─────────────────────────────────────────────────────────
  window.__curlRunner = {
    onShow() {
      if (!built) { buildSkeleton(); switchMode('empty'); renderResponse(); }
      loadStored();
    },
  };

  loadStored();
})();

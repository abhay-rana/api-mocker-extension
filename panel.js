// ── Connection ─────────────────────────────────────────────────────────────
const tabId = chrome.devtools.inspectedWindow.tabId;
const port  = chrome.runtime.connect({ name: `panel:${tabId}` });

// ── State ──────────────────────────────────────────────────────────────────
let calls = [];
let mocks = {};
let selectedCall = null;
let filterText = '';
let currentPanelDomain = '';

// ── Disabled overlay ────────────────────────────────────────────────────────
const disabledOverlay = document.getElementById('disabledOverlay');
const overlayDomain   = document.getElementById('overlayDomain');
const overlayEnableBtn = document.getElementById('overlayEnableBtn');

function setDomainEnabled(domain, enabled) {
  currentPanelDomain = domain;
  overlayDomain.textContent = domain;
  if (enabled) {
    disabledOverlay.classList.add('hidden');
  } else {
    disabledOverlay.classList.remove('hidden');
  }
}

overlayEnableBtn.addEventListener('click', () => {
  if (!currentPanelDomain) return;
  chrome.runtime.sendMessage(
    { type: 'SET_DOMAIN_STATUS', domain: currentPanelDomain, enabled: true },
    () => void chrome.runtime.lastError
  );
});

// ── Undo / redo stack for mock editor ─────────────────────────────────────
const undoStack = [];   // [{ value, selStart, selEnd }, ...]
let undoPtr = -1;
const MAX_UNDO = 100;
let undoDebounceTimer = null;

function pushUndo(immediate = false) {
  const snap = {
    value: mockBodyEl.value,
    selStart: mockBodyEl.selectionStart,
    selEnd: mockBodyEl.selectionEnd,
  };
  // Don't push duplicate snapshots.
  if (undoPtr >= 0 && undoStack[undoPtr].value === snap.value) return;
  // Truncate any redo history ahead of current pointer.
  undoStack.splice(undoPtr + 1);
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) { undoStack.shift(); }
  undoPtr = undoStack.length - 1;
}

function applyUndo() {
  if (undoPtr <= 0) return;
  // Push current state as a "redo" snapshot if pointer is at tip.
  if (undoPtr === undoStack.length - 1) pushUndo(true);
  undoPtr = Math.max(0, undoPtr - 1);
  restoreSnapshot(undoStack[undoPtr]);
}

function applyRedo() {
  if (undoPtr >= undoStack.length - 1) return;
  undoPtr++;
  restoreSnapshot(undoStack[undoPtr]);
}

function restoreSnapshot(snap) {
  mockBodyEl.value = snap.value;
  try { mockBodyEl.setSelectionRange(snap.selStart, snap.selEnd); } catch {}
  syncHighlight();
  const v = mockBodyEl.value.trim();
  if (v && !isJsonOrEmpty(v)) {
    jsonErrorEl.classList.remove('hidden');
  } else {
    jsonErrorEl.classList.add('hidden');
  }
}

function resetUndoStack() {
  undoStack.length = 0;
  undoPtr = -1;
  // Push initial state immediately after value is set.
  requestAnimationFrame(() => pushUndo(true));
}

// ── DOM ────────────────────────────────────────────────────────────────────
const callListEl    = document.getElementById('callList');
const callListCol   = document.getElementById('callListCol');
const detailEmpty   = document.getElementById('detailEmpty');
const detailContent = document.getElementById('detailContent');
const detailHeader  = document.getElementById('detailHeader');
const jsonTree      = document.getElementById('jsonTree');
const mockColTitle  = document.getElementById('mockColTitle');
const editorHL      = document.getElementById('editorHL');
const mockBodyEl    = document.getElementById('mockBody');
const mockStatusEl  = document.getElementById('mockStatus');
const mockActionsEl = document.getElementById('mockActions');
const jsonErrorEl   = document.getElementById('jsonError');
const callCountEl   = document.getElementById('callCount');
const mockCountEl   = document.getElementById('mockCount');
const filterInput   = document.getElementById('filterInput');
const resetOrigBtn  = document.getElementById('resetOrigBtn');

// ── Resize handle ──────────────────────────────────────────────────────────
const resizeHandle = document.getElementById('resizeHandle');
let resizing = false, resizeStartX = 0, resizeStartW = 0;

const RESIZE_KEY = 'api-mocker-list-width';
const savedW = parseInt(localStorage.getItem(RESIZE_KEY), 10);
if (savedW && savedW > 100) callListCol.style.width = savedW + 'px';

resizeHandle.addEventListener('mousedown', (e) => {
  resizing = true;
  resizeStartX = e.clientX;
  resizeStartW = callListCol.offsetWidth;
  resizeHandle.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const w = Math.max(160, Math.min(resizeStartW + e.clientX - resizeStartX, window.innerWidth * 0.6));
  callListCol.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  localStorage.setItem(RESIZE_KEY, callListCol.offsetWidth);
});

// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + 'View').classList.remove('hidden');
  });
});

function clearLog() {
  calls = [];
  selectedCall = null;
  renderCallList();
  showEmptyDetail();
  port.postMessage({ type: 'CLEAR_LOG' });
}

document.getElementById('clearBtn').addEventListener('click', clearLog);

document.getElementById('reloadBtn').addEventListener('click', () => {
  chrome.tabs.reload(tabId);
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); clearLog(); }
  if (e.ctrlKey && e.key === 'r') { e.preventDefault(); chrome.tabs.reload(tabId); }
});

filterInput.addEventListener('input', () => {
  filterText = filterInput.value.trim().toLowerCase();
  renderCallList();
});

// ── Port messages ──────────────────────────────────────────────────────────
port.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'INIT_LOG') {
    calls = msg.payload || [];
    selectedCall = null;
    renderCallList();
    showEmptyDetail();
  } else if (msg.type === 'CALL') {
    calls.push(msg.payload);
    renderCallList();
    callCountEl.textContent = visibleCalls().length;
  } else if (msg.type === 'MOCKS_UPDATED') {
    mocks = msg.payload || {};
    mockCountEl.textContent = Object.keys(mocks).length;
    renderMockList();
    if (selectedCall) renderMockPanel(selectedCall);
  } else if (msg.type === 'DOMAIN_STATUS') {
    setDomainEnabled(msg.domain, msg.enabled);
  }
});

// ── Call list ──────────────────────────────────────────────────────────────
function visibleCalls() {
  return filterText ? calls.filter(c => c.url.toLowerCase().includes(filterText)) : calls;
}

function renderCallList() {
  const list = visibleCalls();
  callCountEl.textContent = list.length;
  callListEl.innerHTML = '';

  if (!list.length) {
    callListEl.innerHTML = '<div class="list-empty">No API calls yet — make a request on the page.</div>';
    return;
  }

  [...list].reverse().forEach(c => {
    const el = document.createElement('div');
    const sc = c.status >= 400 ? 'err' : c.status >= 300 ? 'warn' : 'ok';
    const ms = c.mocked ? 'mock' : c.durationMs > 0 ? `${c.durationMs}ms` : '—';
    const key = `${c.method} ${c.url}`;
    const isMocked = c.mocked || !!mocks[key];
    el.className = 'call' + (isMocked ? ' mocked' : '') + (selectedCall === c ? ' selected' : '');
    el.innerHTML = `
      <span class="cm ${c.method}">${esc(c.method)}</span>
      <span class="cs ${sc}">${c.status || '—'}</span>
      <span class="cu" title="${esc(c.url)}">${urlPath(c.url)}</span>
      <span class="ct">${ms}</span>
      <button class="curl-btn" title="Copy as cURL">⧉ cURL</button>
    `;
    el.querySelector('.curl-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      navigator.clipboard.writeText(buildCurl(c)).then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '⧉ cURL';
          btn.classList.remove('copied');
        }, 1500);
      });
    });
    el.addEventListener('click', () => {
      selectedCall = c;
      document.querySelectorAll('.call').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      renderDetail(c);
    });
    callListEl.appendChild(el);
  });
}

// ── Detail rendering ───────────────────────────────────────────────────────
function showEmptyDetail() {
  detailEmpty.style.display = '';
  detailContent.classList.add('hidden');
}

function renderDetail(c) {
  detailEmpty.style.display = 'none';
  detailContent.classList.remove('hidden');

  // Header
  const sc = c.status >= 400 ? '#b91c1c' : c.status >= 300 ? '#b45309' : '#047857';
  detailHeader.innerHTML = `
    <strong class="cm ${c.method}">${esc(c.method)}</strong>
    <span style="color:#6b7280;margin:0 6px">|</span>
    <span style="color:${sc};font-weight:600">${c.status || '—'}</span>
    <span style="color:#6b7280;margin:0 6px">|</span>
    <span style="color:#6b7280">${c.durationMs > 0 ? c.durationMs + 'ms' : c.mocked ? 'mocked' : '—'}</span>
    <span style="color:#6b7280;margin:0 6px">|</span>
    <span title="${esc(c.url)}">${esc(truncUrl(c.url))}</span>
  `;

  // JSON tree (response body viewer)
  renderJsonTree(c.responseBody);

  // Expand / collapse all
  document.getElementById('expandAllBtn').onclick = () => {
    jsonTree.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  };
  document.getElementById('collapseAllBtn').onclick = () => {
    jsonTree.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
  };

  // Mock editor
  renderMockPanel(c);
}

// ── JSON tree ──────────────────────────────────────────────────────────────
function renderJsonTree(raw) {
  if (!raw || !raw.trim()) {
    jsonTree.innerHTML = '<span class="empty">(empty)</span>';
    return;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    jsonTree.innerHTML = `<pre style="margin:0;color:#6b7280;font-size:11px;white-space:pre-wrap">${esc(raw)}</pre>`;
    return;
  }
  jsonTree.innerHTML = buildTree(parsed, 0);
}

function buildTree(val, depth) {
  if (val === null)              return '<span class="jnull">null</span>';
  if (typeof val === 'boolean')  return `<span class="jbool">${val}</span>`;
  if (typeof val === 'number')   return `<span class="jnum">${esc(String(val))}</span>`;
  if (typeof val === 'string') {
    const display = val.length > 120 ? esc(val.slice(0, 120)) + '<span class="jmeta">…</span>' : esc(val);
    return `<span class="jstr">"${display}"</span>`;
  }

  if (Array.isArray(val)) {
    if (!val.length) return '<span class="jbracket">[]</span>';
    const open = depth < 1 ? 'open' : '';
    const items = val.map((v, i) =>
      `<div class="jrow"><span class="jindex">${i}</span><span class="jcolon">: </span>${buildTree(v, depth + 1)}</div>`
    ).join('');
    return `<details class="jtree" ${open}>
      <summary class="jsummary"><span class="jbracket">[</span><span class="jmeta">&nbsp;${val.length} item${val.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">]</span></summary>
      <div class="jchildren">${items}</div>
    </details>`;
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (!keys.length) return '<span class="jbracket">{}</span>';
    const open = depth < 1 ? 'open' : '';
    const items = keys.map(k =>
      `<div class="jrow"><span class="jkey">"${esc(k)}"</span><span class="jcolon">: </span>${buildTree(val[k], depth + 1)}</div>`
    ).join('');
    return `<details class="jtree" ${open}>
      <summary class="jsummary"><span class="jbracket">{</span><span class="jmeta">&nbsp;${keys.length} key${keys.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">}</span></summary>
      <div class="jchildren">${items}</div>
    </details>`;
  }

  return esc(String(val));
}

// ── Mock editor panel ──────────────────────────────────────────────────────
function renderMockPanel(c) {
  const key = `${c.method} ${c.url}`;
  const existing = mocks[key];
  const isEnabled = existing && existing.enabled;

  mockColTitle.textContent = existing ? '✓ Mock Active' : 'Create Mock';
  mockStatusEl.value = existing ? existing.status : (c.status || 200);

  // Only reset editor body when switching to a different call.
  // Preserves undo stack and typed content when mocks-update fires mid-edit.
  if (mockBodyEl.dataset.callId !== String(c.id)) {
    const body = existing ? existing.body : tryPretty(c.responseBody);
    mockBodyEl.value = body;
    mockBodyEl.dataset.callId = String(c.id);
    syncHighlight();
    resetUndoStack();
  }

  // Actions bar
  mockActionsEl.innerHTML = '';
  const saveBtn = makeBtn('primary', existing ? 'Update Mock' : 'Save as Mock', async () => {
    saveBtn.disabled = true;
    await chrome.runtime.sendMessage({
      type: 'SAVE_MOCK',
      payload: {
        method: c.method, url: c.url,
        status: parseInt(mockStatusEl.value, 10) || 200,
        body: mockBodyEl.value,
        enabled: true,
      },
    }, () => void chrome.runtime.lastError);
    saveBtn.disabled = false;
  });
  mockActionsEl.appendChild(saveBtn);

  if (existing) {
    const toggleBtn = makeBtn('', isEnabled ? 'Disable Mock' : 'Enable Mock', async () => {
      toggleBtn.disabled = true;
      await chrome.runtime.sendMessage(
        { type: 'TOGGLE_MOCK', key, enabled: !isEnabled },
        () => void chrome.runtime.lastError
      );
      toggleBtn.disabled = false;
    });
    const delBtn = makeBtn('danger', 'Delete Mock', async () => {
      if (!confirm(`Delete mock for ${c.method} ${c.url}?`)) return;
      await chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key }, () => void chrome.runtime.lastError);
    });
    mockActionsEl.appendChild(toggleBtn);
    mockActionsEl.appendChild(delBtn);

    const badge = document.createElement('span');
    badge.className = 'mock-badge' + (isEnabled ? '' : ' off');
    badge.textContent = isEnabled ? 'ON' : 'OFF';
    mockActionsEl.appendChild(badge);
  }
}

function makeBtn(cls, label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn' + (cls ? ` ${cls}` : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ── Syntax highlighting editor ─────────────────────────────────────────────
function syncHighlight() {
  editorHL.innerHTML = highlightJson(mockBodyEl.value) + '\n'; // trailing \n prevents last-line scroll glitch
}

function syncScroll() {
  editorHL.scrollTop  = mockBodyEl.scrollTop;
  editorHL.scrollLeft = mockBodyEl.scrollLeft;
}

mockBodyEl.addEventListener('input', () => {
  syncHighlight();
  // Debounced snapshot — captures state 600ms after user stops typing.
  clearTimeout(undoDebounceTimer);
  undoDebounceTimer = setTimeout(() => pushUndo(true), 600);
  const v = mockBodyEl.value.trim();
  jsonErrorEl.classList.toggle('hidden', !v || isJsonOrEmpty(v));
});

mockBodyEl.addEventListener('scroll', syncScroll);

// Ctrl+Z → undo, Ctrl+Shift+Z / Ctrl+Y → redo.
// Must preventDefault to stop DevTools shell from consuming the event.
mockBodyEl.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); applyUndo(); return; }
  if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); applyRedo(); return; }
  // Ctrl+Shift+F → format
  if (e.key === 'F' && e.shiftKey) { e.preventDefault(); formatJson(); }
});

// Format JSON button
function formatJson() {
  const v = mockBodyEl.value.trim();
  if (!v) return;
  try {
    pushUndo(true); // snapshot before bulk-change so it's undoable
    mockBodyEl.value = JSON.stringify(JSON.parse(v), null, 2);
    syncHighlight();
    jsonErrorEl.classList.add('hidden');
    pushUndo(true); // snapshot the formatted result
  } catch {}
}
document.getElementById('fmtBtn').addEventListener('click', formatJson);

// ↩ Original button — resets editor to actual response body of selected call.
resetOrigBtn.addEventListener('click', () => {
  if (!selectedCall) return;
  pushUndo(true); // save current edit so user can undo this reset
  mockBodyEl.value = tryPretty(selectedCall.responseBody);
  syncHighlight();
  jsonErrorEl.classList.add('hidden');
  pushUndo(true); // snapshot the restored state
});

function highlightJson(raw) {
  // Tokenise raw JSON text into colored spans.
  // Regex groups: (1) string value  (2) number  (3) literal  (4) punctuation
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(?:\\.|[^"\\])*")\s*(:)|("(?:\\.|[^"\\])*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)|([{}[\],:])/g,
    (m, keyStr, colon, valStr, literal, num, punct) => {
      if (keyStr && colon)  return `<span class="hk">${keyStr}</span><span class="hp">${colon}</span>`;
      if (valStr)           return `<span class="hs">${valStr}</span>`;
      if (literal === 'true' || literal === 'false') return `<span class="hb">${literal}</span>`;
      if (literal === 'null') return `<span class="hu">${literal}</span>`;
      if (num !== undefined)  return `<span class="hn">${num}</span>`;
      if (punct)              return `<span class="hp">${punct}</span>`;
      return m;
    }
  );
}

function isJsonOrEmpty(s) {
  if (!s.trim()) return true;
  try { JSON.parse(s); return true; } catch { return false; }
}

// ── Mocks list tab ─────────────────────────────────────────────────────────
function renderMockList() {
  const mockListEl = document.getElementById('mockList');
  const keys = Object.keys(mocks);
  mockCountEl.textContent = keys.length;

  if (!keys.length) {
    mockListEl.innerHTML = '<div class="list-empty">No mocks saved yet.<br>Click a call → "Save as Mock".</div>';
    return;
  }

  mockListEl.innerHTML = '';
  keys.forEach(key => {
    const m = mocks[key];
    const card = document.createElement('div');
    card.className = 'mock-card';
    card.innerHTML = `
      <div class="mock-card-head">
        <span class="cm ${esc(m.method)}">${esc(m.method)}</span>
        <span class="mock-card-url" title="${esc(m.url)}">${esc(m.url)}</span>
        <span class="badge">${m.status}</span>
        <div class="switch ${m.enabled ? 'on' : ''}" data-key="${esc(key)}" title="${m.enabled ? 'Disable' : 'Enable'}"></div>
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px">
        Saved ${new Date(m.savedAt).toLocaleString()}
        &nbsp;·&nbsp;
        <a href="#" class="del-link" data-key="${esc(key)}" style="color:#b91c1c">delete</a>
      </div>
    `;
    card.querySelector('.switch').addEventListener('click', e => {
      const k = e.currentTarget.dataset.key;
      chrome.runtime.sendMessage({ type: 'TOGGLE_MOCK', key: k, enabled: !m.enabled },
        () => void chrome.runtime.lastError);
    });
    card.querySelector('.del-link').addEventListener('click', async e => {
      e.preventDefault();
      const k = e.target.dataset.key;
      if (!confirm(`Delete mock for ${k}?`)) return;
      await chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key: k },
        () => void chrome.runtime.lastError);
    });
    mockListEl.appendChild(card);
  });
}

// ── cURL builder ──────────────────────────────────────────────────────────
const HEADER_BLOCKLIST = new Set([
  'accept-encoding', 'content-length', 'host', 'connection', 'origin', 'referer',
]);

function escShell(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildCurl(c) {
  const parts = [`curl -X ${c.method}`];
  const headers = c.requestHeaders || {};
  for (const [k, v] of Object.entries(headers)) {
    const kl = k.toLowerCase();
    if (HEADER_BLOCKLIST.has(kl) || kl.startsWith('sec-')) continue;
    parts.push(`  -H ${escShell(`${k}: ${v}`)}`);
  }
  if (c.requestBody) parts.push(`  --data ${escShell(c.requestBody)}`);
  parts.push(`  ${escShell(c.url)}`);
  return parts.join(' \\\n');
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function urlPath(url) {
  try {
    const u = new URL(url);
    const p = u.pathname + (u.search.length > 24 ? u.search.slice(0, 24) + '…' : u.search);
    return esc(p);
  } catch { return esc(url.slice(0, 50)); }
}
function truncUrl(url) {
  return url.length > 120 ? url.slice(0, 120) + '…' : url;
}
function tryPretty(s) {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

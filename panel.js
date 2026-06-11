// ── Diagnostic log ─────────────────────────────────────────────────────────
const diagLog = [];
const MAX_DIAG = 50;
function addDiag(msg) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' + String(now.getMilliseconds()).padStart(3, '0');
  diagLog.push({ time, msg });
  if (diagLog.length > MAX_DIAG) diagLog.shift();
}

// ── Connection ─────────────────────────────────────────────────────────────
const tabId = chrome.devtools.inspectedWindow.tabId;
let port;

function connectPort() {
  port = chrome.runtime.connect({ name: `panel:${tabId}` });
  port.onMessage.addListener(onPortMessage);

  // Keep SW alive — MV3 kills idle SWs after 30s; ping every 25s to reset the timer.
  const keepAlive = setInterval(() => {
    try { port.postMessage({ type: 'PING' }); } catch { clearInterval(keepAlive); }
  }, 25_000);

  port.onDisconnect.addListener(() => {
    clearInterval(keepAlive);
    addDiag('SW disconnected — reconnecting…');
    setTimeout(connectPort, 150);
  });
  addDiag('Port connected to SW');
}

function onPortMessage(msg) {
  if (!msg) return;
  if (msg.type === 'INIT_LOG') {
    const prevCount = calls.length;
    const reason = msg.reason || 'unknown';
    const reasonLabel = reason === 'navigation' ? 'page navigation'
      : reason === 'reconnect' ? 'SW reconnect'
      : reason === 'clear' ? 'Clear button'
      : reason;
    addDiag(`Log cleared — ${reasonLabel} (had ${prevCount} call${prevCount !== 1 ? 's' : ''})`);
    calls = msg.payload || [];
    selectedCall = null;
    renderCallList();
    showEmptyDetail();
  } else if (msg.type === 'CALL') {
    if (!isRecording) return;
    calls.push(msg.payload);
    appendSingleCall(msg.payload);
  } else if (msg.type === 'MOCKS_UPDATED') {
    mocks = msg.payload || {};
    mockCountEl.textContent = Object.keys(mocks).length;
    renderMockList();
    if (selectedCall) renderMockPanel(selectedCall);
  } else if (msg.type === 'DOMAIN_STATUS') {
    setDomainEnabled(msg.domain, msg.enabled);
  }
}

connectPort();

// ── State ──────────────────────────────────────────────────────────────────
let calls = [];
let mocks = {};
let selectedCall = null;
let selectedCallEl = null; // direct ref — avoids querySelectorAll on every click
let filterText = '';
let currentPanelDomain = '';
let activeBodyTab = 'response'; // 'response' | 'request'
let lastMockPanelState = ''; // serialized key to skip redundant action-bar rebuilds
let isRecording = true;

// ── Disabled overlay ────────────────────────────────────────────────────────
const disabledOverlay = document.getElementById('disabledOverlay');
const overlayDomain   = document.getElementById('overlayDomain');
const overlayEnableBtn = document.getElementById('overlayEnableBtn');

function setDomainEnabled(domain, enabled) {
  currentPanelDomain = domain;
  overlayDomain.textContent = domain;
  if (domainPillText) domainPillText.textContent = domain || '—';
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

// ── Editor mode ────────────────────────────────────────────────────────────
const EDITOR_MODE_KEY = 'api-mocker-editor-mode';
let editorMode = localStorage.getItem(EDITOR_MODE_KEY) || 'tree'; // 'tree' | 'codemirror'
let cmEditor = null;

// ── Mock tree state ────────────────────────────────────────────────────────
let mockContent = null; // { json: parsedObj, raw: string, isJson: boolean }
let currentMockCallId = null;

// ── Mock drawer state ──────────────────────────────────────────────────────
let openMockKey    = null;
let drawerEl       = null;
let drawerCmEditor = null;
let drawerMode     = editorMode;
let drawerMockContent = null;

function setMockContent(rawText) {
  const raw = rawText || '';
  let parsed = null, isJson = false;
  if (raw.trim()) {
    try { parsed = JSON.parse(raw); isJson = true; } catch {}
  }
  mockContent = { json: parsed, raw, isJson };
}

function getMockBody() {
  if (editorMode === 'codemirror' && cmEditor) return cmEditor.state.doc.toString();
  if (!mockContent) return '';
  return mockContent.isJson ? JSON.stringify(mockContent.json, null, 2) : mockContent.raw;
}

function setAtPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) cur = cur[pathArr[i]];
  cur[pathArr[pathArr.length - 1]] = value;
}

function parseLeafValue(raw, vtype) {
  if (vtype === 'string')  return raw;
  if (vtype === 'number')  { const n = Number(raw); return isNaN(n) ? raw : n; }
  if (vtype === 'boolean') return raw === 'true';
  try { return JSON.parse(raw); } catch { return raw === '' ? null : raw; }
}

function serializePath(path) {
  return encodeURIComponent(JSON.stringify(path));
}

function deserializePath(encoded) {
  return JSON.parse(decodeURIComponent(encoded));
}

function leafSpanHtml(val, path) {
  const p = serializePath(path);
  if (val === null)             return `<span class="jnull editable-leaf" data-path="${p}" data-vtype="null">null</span>`;
  if (typeof val === 'boolean') return `<span class="jbool editable-leaf" data-path="${p}" data-vtype="boolean">${val}</span>`;
  if (typeof val === 'number')  return `<span class="jnum editable-leaf" data-path="${p}" data-vtype="number">${esc(String(val))}</span>`;
  if (typeof val === 'string') {
    const display = val.length > 120 ? esc(val.slice(0, 120)) + '<span class="jmeta">…</span>' : esc(val);
    return `<span class="jstr editable-leaf" data-path="${p}" data-vtype="string" data-raw="${esc(val)}">"${display}"</span>`;
  }
  return esc(String(val));
}

function buildEditableTree(val, depth, path) {
  if (val === null || typeof val !== 'object') return leafSpanHtml(val, path);

  if (Array.isArray(val)) {
    if (!val.length) return '<span class="jbracket">[]</span>';
    const open = depth < 1 ? 'open' : '';
    const items = val.map((v, i) =>
      `<div class="jrow"><span class="jindex">${i}</span><span class="jcolon">: </span>${buildEditableTree(v, depth + 1, [...path, i])}</div>`
    ).join('');
    return `<details class="jtree" ${open}>
      <summary class="jsummary"><span class="jbracket">[</span><span class="jmeta">&nbsp;${val.length} item${val.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">]</span></summary>
      <div class="jchildren">${items}</div>
    </details>`;
  }

  const keys = Object.keys(val);
  if (!keys.length) return '<span class="jbracket">{}</span>';
  const open = depth < 1 ? 'open' : '';
  const items = keys.map(k =>
    `<div class="jrow"><span class="jkey">"${esc(k)}"</span><span class="jcolon">: </span>${buildEditableTree(val[k], depth + 1, [...path, k])}</div>`
  ).join('');
  return `<details class="jtree" ${open}>
    <summary class="jsummary"><span class="jbracket">{</span><span class="jmeta">&nbsp;${keys.length} key${keys.length !== 1 ? 's' : ''}&nbsp;</span><span class="jbracket">}</span></summary>
    <div class="jchildren">${items}</div>
  </details>`;
}

function renderMockContentArea() {
  closeTreeSearch();
  const treeEl     = document.getElementById('mockTree');
  const expandBtn  = document.getElementById('mockExpandAllBtn');
  const collapseBtn = document.getElementById('mockCollapseAllBtn');

  if (!mockContent || !mockContent.raw.trim()) {
    treeEl.innerHTML = '<span class="empty">(empty)</span>';
    expandBtn.style.display  = 'none';
    collapseBtn.style.display = 'none';
    return;
  }

  if (mockContent.isJson) {
    treeEl.innerHTML = buildEditableTree(mockContent.json, 0, []);
  } else {
    treeEl.innerHTML = `<pre style="margin:0;color:#6b7280;font-size:11px;white-space:pre-wrap">${esc(mockContent.raw)}</pre>`;
  }

  if (editorMode === 'tree') {
    const hasTree = treeEl.querySelector('details') !== null;
    expandBtn.style.display  = hasTree ? '' : 'none';
    collapseBtn.style.display = hasTree ? '' : 'none';
  }
}

// ── CodeMirror (editor mode) ───────────────────────────────────────────────
function initCodeMirror() {
  const {
    EditorView, EditorState, keymap,
    lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
    json, foldGutter, foldKeymap, bracketMatching,
    syntaxHighlighting, HighlightStyle,
    history, historyKeymap, defaultKeymap,
    search, searchKeymap,
    closeBrackets, closeBracketsKeymap,
    tags,
  } = window.CM;

  const jsonHighlight = HighlightStyle.define([
    { tag: tags.propertyName,  color: '#2563EB' },
    { tag: tags.string,        color: '#16A34A' },
    { tag: tags.number,        color: '#EA580C' },
    { tag: tags.bool,          color: '#9333EA' },
    { tag: tags.null,          color: '#EF4444' },
    { tag: tags.punctuation,   color: '#0F172A' },
    { tag: tags.bracket,       color: '#0F172A', fontWeight: 'bold' },
  ]);

  cmEditor = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        history(),
        highlightActiveLine(),
        json(),
        syntaxHighlighting(jsonHighlight),
        search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
          { key: 'Ctrl-Shift-f', run: (view) => {
            const v = view.state.doc.toString().trim();
            if (!v) return true;
            try {
              const fmt = JSON.stringify(JSON.parse(v), null, 2);
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fmt } });
            } catch {}
            return true;
          }},
        ]),
        EditorView.theme({
          '&': { height: '100%', background: '#FFFFFF', fontSize: '11px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: "'Roboto Mono', ui-monospace, Consolas, monospace", lineHeight: '1.6' },
          '.cm-content': { padding: '10px 0', caretColor: '#0F172A' },
          '.cm-gutters': { background: '#F8FAFC', border: 'none', borderRight: '1px solid #E2E8F0' },
          '.cm-lineNumbers .cm-gutterElement': { color: '#94A3B8', minWidth: '32px', padding: '0 8px 0 4px' },
          '.cm-foldGutter .cm-gutterElement': { color: '#94A3B8', padding: '0 4px', cursor: 'pointer' },
          '.cm-activeLine': { background: 'rgba(59,130,246,0.04)' },
          '.cm-activeLineGutter': { background: 'rgba(59,130,246,0.04)' },
          '.cm-matchingBracket': { background: 'rgba(59,130,246,0.15)', borderRadius: '2px', outline: 'none' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(59,130,246,0.15)' },
          '.cm-cursor': { borderLeftColor: '#0F172A' },
          '.cm-searchMatch': { background: 'rgba(253,224,71,0.5)', borderRadius: '2px' },
          '.cm-searchMatch.cm-searchMatch-selected': { background: 'rgba(251,146,60,0.5)' },
          '.cm-panels': { background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' },
          '.cm-panel.cm-search': { padding: '4px 8px', fontSize: '11px', fontFamily: "'Roboto Mono', ui-monospace, monospace" },
          '.cm-panel.cm-search input': { border: '1px solid #E2E8F0', borderRadius: '3px', padding: '2px 5px', fontSize: '11px' },
          '.cm-panel.cm-search button': { padding: '2px 7px', border: '1px solid #E2E8F0', borderRadius: '3px', background: '#F1F5F9', fontSize: '11px', cursor: 'pointer', marginLeft: '4px' },
          '.cm-foldPlaceholder': { background: '#DBEAFE', border: '1px solid #93C5FD', color: '#1D4ED8', borderRadius: '3px', padding: '0 4px', cursor: 'pointer' },
        }),
      ],
    }),
    parent: document.getElementById('cmEditorWrap'),
  });
}

function cmSetValue(text) {
  if (!cmEditor) return;
  cmEditor.dispatch({ changes: { from: 0, to: cmEditor.state.doc.length, insert: text } });
}

function ensureCmInitialized() {
  if (!cmEditor) initCodeMirror();
}

function applyEditorModeVisibility() {
  const treeEl      = document.getElementById('mockTree');
  const cmWrapEl    = document.getElementById('cmEditorWrap');
  const expandBtn   = document.getElementById('mockExpandAllBtn');
  const collapseBtn = document.getElementById('mockCollapseAllBtn');
  const selectEl    = document.getElementById('editorModeSelect');
  const searchBtn   = document.getElementById('mockTreeSearchBtn');

  if (editorMode === 'codemirror') {
    treeEl.style.display    = 'none';
    cmWrapEl.style.display  = '';
    expandBtn.style.display  = 'none';
    collapseBtn.style.display = 'none';
  } else {
    treeEl.style.display    = '';
    cmWrapEl.style.display  = 'none';
    // expand/collapse visibility is managed by renderMockContentArea
  }
  selectEl.value = editorMode;
}

function switchEditorMode(newMode) {
  if (newMode === editorMode) return;
  if (editorMode === 'tree') closeTreeSearch();

  const current = getMockBody(); // grab content from the currently active editor
  editorMode = newMode;
  localStorage.setItem(EDITOR_MODE_KEY, editorMode);

  applyEditorModeVisibility();

  if (newMode === 'codemirror') {
    ensureCmInitialized();
    cmSetValue(current);
  } else {
    setMockContent(current);
    renderMockContentArea();
  }
}

// ── Tree search ────────────────────────────────────────────────────────────
let treeSearchMatches = [];
let treeSearchIdx = -1;

function openTreeSearch() {
  document.getElementById('mockTreeSearch').style.display = '';
  const input = document.getElementById('mockTreeSearchInput');
  input.focus();
  input.select();
  if (input.value.trim()) runTreeSearch(input.value);
}

function closeTreeSearch() {
  document.getElementById('mockTreeSearch').style.display = 'none';
  clearTreeHighlights();
  treeSearchMatches = [];
  treeSearchIdx = -1;
  document.getElementById('mockTreeSearchInput').value = '';
  document.getElementById('mockTreeSearchCount').textContent = '';
}

function runTreeSearch(query) {
  clearTreeHighlights();
  treeSearchMatches = [];
  treeSearchIdx = -1;

  const q = query.trim().toLowerCase();
  if (!q) { updateTreeSearchCount(); return; }

  document.getElementById('mockTree')
    .querySelectorAll('.jkey, .jstr, .jnum, .jbool, .jnull')
    .forEach(el => {
      if (el.textContent.toLowerCase().includes(q)) {
        el.classList.add('tree-match');
        treeSearchMatches.push(el);
      }
    });

  if (treeSearchMatches.length) { treeSearchIdx = 0; activateTreeMatch(0); }
  else updateTreeSearchCount();
}

function activateTreeMatch(idx) {
  treeSearchMatches.forEach(el => el.classList.remove('tree-match-current'));
  if (idx < 0 || idx >= treeSearchMatches.length) return;
  treeSearchIdx = idx;
  const el = treeSearchMatches[idx];
  el.classList.add('tree-match-current');
  // expand every ancestor <details> so the match is visible
  let node = el.parentElement;
  while (node) {
    if (node.tagName === 'DETAILS') node.setAttribute('open', '');
    node = node.parentElement;
  }
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateTreeSearchCount();
}

function updateTreeSearchCount() {
  const el = document.getElementById('mockTreeSearchCount');
  el.textContent = treeSearchMatches.length
    ? `${treeSearchIdx + 1} / ${treeSearchMatches.length}`
    : (document.getElementById('mockTreeSearchInput').value.trim() ? 'No results' : '');
}

function clearTreeHighlights() {
  document.getElementById('mockTree')
    .querySelectorAll('.tree-match, .tree-match-current')
    .forEach(el => el.classList.remove('tree-match', 'tree-match-current'));
}

// ── DOM ────────────────────────────────────────────────────────────────────
const callListEl      = document.getElementById('callList');
const callListCol     = document.getElementById('callListCol');
const detailEmpty     = document.getElementById('detailEmpty');
const detailContent   = document.getElementById('detailContent');
const detailHeader    = document.getElementById('detailHeader');
const jsonTree        = document.getElementById('jsonTree');
const mockActiveBadge = document.getElementById('mockActiveBadge');
const mockStatusEl    = document.getElementById('mockStatus');
const mockActionsEl   = document.getElementById('mockActions');
const jsonErrorEl     = document.getElementById('jsonError');
const callCountEl     = document.getElementById('callCount');
const mockCountEl     = document.getElementById('mockCount');
const filterInput     = document.getElementById('filterInput');
const resetOrigBtn    = document.getElementById('resetOrigBtn');
const enableAllBtn    = document.getElementById('enableAllBtn');
const disableAllBtn   = document.getElementById('disableAllBtn');
const deleteAllBtn    = document.getElementById('deleteAllBtn');
const sortToggleBtn   = document.getElementById('sortToggleBtn');
const domainPillText  = document.getElementById('domainPillText');

// ── Diagnostic overlay ─────────────────────────────────────────────────────
const diagOverlay  = document.getElementById('diagOverlay');
const diagList     = document.getElementById('diagList');
const diagBtn      = document.getElementById('diagBtn');
const diagCloseBtn = document.getElementById('diagCloseBtn');
const diagClearBtn = document.getElementById('diagClearBtn');

function renderDiagLog() {
  if (!diagLog.length) {
    diagList.innerHTML = '<span class="diag-empty">No events yet.</span>';
    return;
  }
  diagList.innerHTML = diagLog.slice().reverse().map(e => {
    const isClear = e.msg.startsWith('Log cleared');
    const isDisc  = e.msg.startsWith('SW disconnected');
    const cls = isClear ? 'diag-row diag-row--warn' : isDisc ? 'diag-row diag-row--err' : 'diag-row';
    return `<div class="${cls}"><span class="diag-time">${e.time}</span><span class="diag-msg">${e.msg}</span></div>`;
  }).join('');
}

diagBtn.addEventListener('click', () => {
  diagOverlay.classList.toggle('hidden');
  if (!diagOverlay.classList.contains('hidden')) renderDiagLog();
});
diagCloseBtn.addEventListener('click', () => diagOverlay.classList.add('hidden'));
diagClearBtn.addEventListener('click', () => { diagLog.length = 0; renderDiagLog(); });

// ── Record toggle ──────────────────────────────────────────────────────────
const recordToggleBtn = document.getElementById('recordToggleBtn');
recordToggleBtn.addEventListener('click', () => {
  isRecording = !isRecording;
  recordToggleBtn.classList.toggle('rec-btn--paused', !isRecording);
  recordToggleBtn.title = isRecording ? 'Recording — click to pause' : 'Paused — click to resume';
});

// ── Sort order ─────────────────────────────────────────────────────────────
const SORT_KEY = 'api-mocker-sort';
let sortNewestBottom = localStorage.getItem(SORT_KEY) !== 'oldest';
let autoScrollEnabled = true;

function updateSortBtn() {
  const label = sortToggleBtn.querySelector('span');
  if (label) label.textContent = sortNewestBottom ? 'Newest' : 'Oldest';
  sortToggleBtn.classList.toggle('action-chip--active', sortNewestBottom);
}
updateSortBtn();

callListEl.addEventListener('scroll', () => {
  const atBottom = callListEl.scrollHeight - callListEl.scrollTop - callListEl.clientHeight < 8;
  autoScrollEnabled = atBottom;
});

sortToggleBtn.addEventListener('click', () => {
  sortNewestBottom = !sortNewestBottom;
  localStorage.setItem(SORT_KEY, sortNewestBottom ? 'newest' : 'oldest');
  updateSortBtn();
  autoScrollEnabled = true;
  renderCallList();
});

// ── Editor mode select ────────────────────────────────────────────────────
document.getElementById('editorModeSelect').addEventListener('change', (e) => {
  switchEditorMode(e.target.value);
});
applyEditorModeVisibility();

// ── Mock tree expand / collapse ────────────────────────────────────────────
document.getElementById('mockExpandAllBtn').addEventListener('click', () => {
  document.getElementById('mockTree').querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
});
document.getElementById('mockCollapseAllBtn').addEventListener('click', () => {
  document.getElementById('mockTree').querySelectorAll('details').forEach(d => d.removeAttribute('open'));
});

// ── Tree search events ─────────────────────────────────────────────────────
document.getElementById('mockTreeSearchBtn').addEventListener('click', () => {
  if (editorMode === 'codemirror' && cmEditor) {
    window.CM.search.openSearchPanel(cmEditor);
    cmEditor.focus();
  } else {
    openTreeSearch();
  }
});

document.getElementById('mockTreeSearchInput').addEventListener('input', (e) => {
  runTreeSearch(e.target.value);
});
document.getElementById('mockTreeSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeTreeSearch(); return; }
  if (e.key === 'Enter' && treeSearchMatches.length) {
    e.preventDefault();
    const next = e.shiftKey
      ? (treeSearchIdx - 1 + treeSearchMatches.length) % treeSearchMatches.length
      : (treeSearchIdx + 1) % treeSearchMatches.length;
    activateTreeMatch(next);
  }
});
document.getElementById('mockTreeSearchPrev').addEventListener('click', () => {
  if (!treeSearchMatches.length) return;
  activateTreeMatch((treeSearchIdx - 1 + treeSearchMatches.length) % treeSearchMatches.length);
});
document.getElementById('mockTreeSearchNext').addEventListener('click', () => {
  if (!treeSearchMatches.length) return;
  activateTreeMatch((treeSearchIdx + 1) % treeSearchMatches.length);
});
document.getElementById('mockTreeSearchClose').addEventListener('click', closeTreeSearch);

// ── Mock tree leaf editing (event delegation) ──────────────────────────────
document.getElementById('mockTree').addEventListener('click', (e) => {
  const leaf = e.target.closest('.editable-leaf');
  if (!leaf) return;
  startLeafEdit(leaf);
});

function startLeafEdit(leaf) {
  const path  = deserializePath(leaf.dataset.path);
  const vtype = leaf.dataset.vtype;

  const input = document.createElement('input');
  input.className = 'leaf-input';
  input.type = 'text';
  input.value = vtype === 'string' ? (leaf.dataset.raw || '') : leaf.textContent.trim();

  leaf.replaceWith(input);
  input.focus();
  input.select();

  function finalize(accept) {
    input.removeEventListener('blur', onBlur);
    if (accept) {
      const newVal = parseLeafValue(input.value, vtype);
      setAtPath(mockContent.json, path, newVal);
      const tmp = document.createElement('span');
      tmp.innerHTML = leafSpanHtml(newVal, path);
      input.replaceWith(tmp.firstChild);
    } else {
      input.replaceWith(leaf);
    }
  }

  function onBlur() { finalize(true); }
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); finalize(true); }
    if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
  });
}

// ── Mock drawer ─────────────────────────────────────────────────────────────
function getOrCreateDrawer() {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('div');
  drawerEl.className = 'mock-drawer';
  drawerEl.innerHTML = `
    <div class="mock-drawer-toolbar">
      <select class="mode-select drawer-mode-select">
        <option value="tree">Tree</option>
        <option value="codemirror">Editor</option>
      </select>
      <button class="tiny-btn drawer-expand-btn" style="display:none">Expand all</button>
      <button class="tiny-btn drawer-collapse-btn" style="display:none">Collapse all</button>
      <span style="flex:1"></span>
      <button class="btn primary drawer-save-btn">Save</button>
    </div>
    <div class="mock-drawer-body">
      <div class="tree-wrap drawer-tree"></div>
      <div class="cm-editor-wrap drawer-cm-wrap" style="display:none"></div>
    </div>
    <div class="drawer-json-error hidden">⚠ Invalid JSON — saved as plain text</div>
  `;
  drawerEl.querySelector('.drawer-mode-select').addEventListener('change', e => switchDrawerMode(e.target.value));
  drawerEl.querySelector('.drawer-expand-btn').addEventListener('click', () => {
    drawerEl.querySelector('.drawer-tree').querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  });
  drawerEl.querySelector('.drawer-collapse-btn').addEventListener('click', () => {
    drawerEl.querySelector('.drawer-tree').querySelectorAll('details').forEach(d => d.removeAttribute('open'));
  });
  drawerEl.querySelector('.drawer-tree').addEventListener('click', e => {
    const leaf = e.target.closest('.editable-leaf');
    if (leaf) startDrawerLeafEdit(leaf);
  });
  drawerEl.querySelector('.drawer-save-btn').addEventListener('click', saveDrawerMock);
  return drawerEl;
}

function setDrawerContent(rawText) {
  const raw = rawText || '';
  let parsed = null, isJson = false;
  if (raw.trim()) { try { parsed = JSON.parse(raw); isJson = true; } catch {} }
  drawerMockContent = { json: parsed, raw, isJson };
}

function getDrawerBody() {
  if (drawerMode === 'codemirror' && drawerCmEditor) return drawerCmEditor.state.doc.toString();
  if (!drawerMockContent) return '';
  return drawerMockContent.isJson ? JSON.stringify(drawerMockContent.json, null, 2) : drawerMockContent.raw;
}

function renderDrawerTree() {
  const treeEl      = drawerEl.querySelector('.drawer-tree');
  const expandBtn   = drawerEl.querySelector('.drawer-expand-btn');
  const collapseBtn = drawerEl.querySelector('.drawer-collapse-btn');
  if (!drawerMockContent || !drawerMockContent.raw.trim()) {
    treeEl.innerHTML = '<span class="empty">(empty)</span>';
    expandBtn.style.display = 'none';
    collapseBtn.style.display = 'none';
    return;
  }
  if (drawerMockContent.isJson) {
    treeEl.innerHTML = buildEditableTree(drawerMockContent.json, 0, []);
  } else {
    treeEl.innerHTML = `<pre style="margin:0;color:#6b7280;font-size:11px;white-space:pre-wrap">${esc(drawerMockContent.raw)}</pre>`;
  }
  if (drawerMode === 'tree') {
    const hasTree = treeEl.querySelector('details') !== null;
    expandBtn.style.display   = hasTree ? '' : 'none';
    collapseBtn.style.display = hasTree ? '' : 'none';
  }
}

function applyDrawerModeVisibility() {
  const treeEl      = drawerEl.querySelector('.drawer-tree');
  const cmWrap      = drawerEl.querySelector('.drawer-cm-wrap');
  const expandBtn   = drawerEl.querySelector('.drawer-expand-btn');
  const collapseBtn = drawerEl.querySelector('.drawer-collapse-btn');
  const selectEl    = drawerEl.querySelector('.drawer-mode-select');
  if (drawerMode === 'codemirror') {
    treeEl.style.display      = 'none';
    cmWrap.style.display      = '';
    expandBtn.style.display   = 'none';
    collapseBtn.style.display = 'none';
  } else {
    treeEl.style.display  = '';
    cmWrap.style.display  = 'none';
    // expand/collapse visibility managed by renderDrawerTree
  }
  selectEl.value = drawerMode;
}

function initDrawerCodeMirror() {
  if (drawerCmEditor) return;
  const { EditorView, EditorState, keymap,
    lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
    json, foldGutter, foldKeymap, bracketMatching,
    syntaxHighlighting, HighlightStyle,
    history, historyKeymap, defaultKeymap,
    search, searchKeymap,
    closeBrackets, closeBracketsKeymap, tags } = window.CM;
  const jsonHighlight = HighlightStyle.define([
    { tag: tags.propertyName, color: '#2563EB' },
    { tag: tags.string,       color: '#16A34A' },
    { tag: tags.number,       color: '#EA580C' },
    { tag: tags.bool,         color: '#9333EA' },
    { tag: tags.null,         color: '#EF4444' },
    { tag: tags.punctuation,  color: '#0F172A' },
    { tag: tags.bracket,      color: '#0F172A', fontWeight: 'bold' },
  ]);
  drawerCmEditor = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), foldGutter(), drawSelection(),
        bracketMatching(), closeBrackets(), history(), highlightActiveLine(),
        json(), syntaxHighlighting(jsonHighlight), search({ top: true }),
        keymap.of([
          ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
          ...foldKeymap, ...searchKeymap,
          { key: 'Ctrl-Shift-f', run: (view) => {
            const v = view.state.doc.toString().trim();
            if (!v) return true;
            try {
              const fmt = JSON.stringify(JSON.parse(v), null, 2);
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: fmt } });
            } catch {}
            return true;
          }},
        ]),
        EditorView.theme({
          '&': { height: '100%', background: '#FFFFFF', fontSize: '11px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: "'Roboto Mono', ui-monospace, Consolas, monospace", lineHeight: '1.6' },
          '.cm-content': { padding: '10px 0', caretColor: '#0F172A' },
          '.cm-gutters': { background: '#F8FAFC', border: 'none', borderRight: '1px solid #E2E8F0' },
          '.cm-lineNumbers .cm-gutterElement': { color: '#94A3B8', minWidth: '32px', padding: '0 8px 0 4px' },
          '.cm-foldGutter .cm-gutterElement': { color: '#94A3B8', padding: '0 4px', cursor: 'pointer' },
          '.cm-activeLine': { background: 'rgba(59,130,246,0.04)' },
          '.cm-activeLineGutter': { background: 'rgba(59,130,246,0.04)' },
          '.cm-matchingBracket': { background: 'rgba(59,130,246,0.15)', borderRadius: '2px', outline: 'none' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(59,130,246,0.15)' },
          '.cm-cursor': { borderLeftColor: '#0F172A' },
          '.cm-searchMatch': { background: 'rgba(253,224,71,0.5)', borderRadius: '2px' },
          '.cm-searchMatch.cm-searchMatch-selected': { background: 'rgba(251,146,60,0.5)' },
          '.cm-panels': { background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' },
          '.cm-panel.cm-search': { padding: '4px 8px', fontSize: '11px', fontFamily: "'Roboto Mono', ui-monospace, monospace" },
          '.cm-panel.cm-search input': { border: '1px solid #E2E8F0', borderRadius: '3px', padding: '2px 5px', fontSize: '11px' },
          '.cm-panel.cm-search button': { padding: '2px 7px', border: '1px solid #E2E8F0', borderRadius: '3px', background: '#F1F5F9', fontSize: '11px', cursor: 'pointer', marginLeft: '4px' },
          '.cm-foldPlaceholder': { background: '#DBEAFE', border: '1px solid #93C5FD', color: '#1D4ED8', borderRadius: '3px', padding: '0 4px', cursor: 'pointer' },
        }),
      ],
    }),
    parent: drawerEl.querySelector('.drawer-cm-wrap'),
  });
}

function drawerCmSetValue(text) {
  if (!drawerCmEditor) return;
  drawerCmEditor.dispatch({ changes: { from: 0, to: drawerCmEditor.state.doc.length, insert: text } });
}

function switchDrawerMode(newMode) {
  if (newMode === drawerMode) return;
  const current = getDrawerBody();
  drawerMode = newMode;
  applyDrawerModeVisibility();
  if (newMode === 'codemirror') {
    initDrawerCodeMirror();
    drawerCmSetValue(current);
  } else {
    setDrawerContent(current);
    renderDrawerTree();
  }
}

function startDrawerLeafEdit(leaf) {
  const path  = deserializePath(leaf.dataset.path);
  const vtype = leaf.dataset.vtype;
  const input = document.createElement('input');
  input.className = 'leaf-input';
  input.type = 'text';
  input.value = vtype === 'string' ? (leaf.dataset.raw || '') : leaf.textContent.trim();
  leaf.replaceWith(input);
  input.focus();
  input.select();
  function finalize(accept) {
    input.removeEventListener('blur', onBlur);
    if (accept) {
      const newVal = parseLeafValue(input.value, vtype);
      setAtPath(drawerMockContent.json, path, newVal);
      const tmp = document.createElement('span');
      tmp.innerHTML = leafSpanHtml(newVal, path);
      input.replaceWith(tmp.firstChild);
    } else {
      input.replaceWith(leaf);
    }
  }
  function onBlur() { finalize(true); }
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); finalize(true); }
    if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
  });
}

function saveDrawerMock() {
  if (!openMockKey || !mocks[openMockKey]) return;
  const m      = mocks[openMockKey];
  const body   = getDrawerBody();
  const saveBtn = drawerEl.querySelector('.drawer-save-btn');
  const errEl   = drawerEl.querySelector('.drawer-json-error');
  if (body.trim()) {
    try { JSON.parse(body); errEl.classList.add('hidden'); }
    catch { errEl.classList.remove('hidden'); }
  } else {
    errEl.classList.add('hidden');
  }
  saveBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'SAVE_MOCK',
    payload: { method: m.method, url: m.url, status: m.status, body, enabled: m.enabled },
  }, () => { void chrome.runtime.lastError; saveBtn.disabled = false; });
}

function openMockDrawer(key) {
  if (!mocks[key]) return;
  const drawer = getOrCreateDrawer();
  const m = mocks[key];
  openMockKey = key;

  const mockListEl = document.getElementById('mockList');
  mockListEl.querySelectorAll('.mock-chevron').forEach(c => c.classList.remove('open'));
  const card = mockListEl.querySelector(`[data-mock-key="${CSS.escape(key)}"]`);
  if (!card) return;

  card.querySelector('.mock-chevron').classList.add('open');
  card.appendChild(drawer); // attach to DOM before CodeMirror init

  const body = tryPretty(m.body);
  setDrawerContent(body);
  drawerMode = editorMode;
  applyDrawerModeVisibility();
  drawerEl.querySelector('.drawer-json-error').classList.add('hidden');

  if (drawerMode === 'codemirror') {
    initDrawerCodeMirror();
    drawerCmSetValue(body);
  } else {
    renderDrawerTree();
  }
}

function closeMockDrawer() {
  openMockKey = null;
  if (drawerEl && drawerEl.parentElement) drawerEl.remove();
  document.getElementById('mockList').querySelectorAll('.mock-chevron')
    .forEach(c => c.classList.remove('open'));
}

// ── Resize handle (left: call list) ───────────────────────────────────────
const resizeHandle = document.getElementById('resizeHandle');
let resizing = false, resizeStartX = 0, resizeStartW = 0, resizeRafId = null, resizeLastX = 0;

const RESIZE_KEY = 'api-mocker-list-width';
const savedW = parseInt(localStorage.getItem(RESIZE_KEY), 10);
if (savedW && savedW > 100) callListCol.style.width = savedW + 'px';

// ── Resize handle (right: mock col) ───────────────────────────────────────
const colDivider = document.getElementById('colDivider');
const mockColEl  = document.getElementById('mockCol');
let colResizing = false, colResizeStartX = 0, colResizeStartW = 0;

const COL_RESIZE_KEY = 'api-mocker-mock-col-width';
const savedMockW = parseInt(localStorage.getItem(COL_RESIZE_KEY), 10);
if (savedMockW && savedMockW > 200) mockColEl.style.width = savedMockW + 'px';

if (colDivider) {
  colDivider.addEventListener('mousedown', (e) => {
    colResizing = true;
    colResizeStartX = e.clientX;
    colResizeStartW = mockColEl.offsetWidth;
    colDivider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
}

resizeHandle.addEventListener('mousedown', (e) => {
  resizing = true;
  resizeStartX = e.clientX;
  resizeLastX = e.clientX;
  resizeStartW = callListCol.offsetWidth;
  resizeHandle.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
});
document.addEventListener('mousemove', (e) => {
  if (resizing) {
    resizeLastX = e.clientX;
    if (resizeRafId) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      const w = Math.max(160, Math.min(resizeStartW + resizeLastX - resizeStartX, window.innerWidth * 0.6));
      callListCol.style.width = w + 'px';
    });
  }
  if (colResizing) {
    const delta = colResizeStartX - e.clientX;
    const w = Math.max(240, Math.min(colResizeStartW + delta, window.innerWidth * 0.55));
    mockColEl.style.width = w + 'px';
  }
});
document.addEventListener('mouseup', () => {
  if (resizing) {
    if (resizeRafId) { cancelAnimationFrame(resizeRafId); resizeRafId = null; }
    resizing = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    localStorage.setItem(RESIZE_KEY, callListCol.offsetWidth);
  }
  if (colResizing) {
    colResizing = false;
    if (colDivider) colDivider.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    localStorage.setItem(COL_RESIZE_KEY, mockColEl.offsetWidth);
  }
});

// ── Tabs (top-level: Inspector / Mocks) ───────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled || !btn.dataset.tab) return;
    const viewId = btn.dataset.tab + 'View';
    if (!document.getElementById(viewId)) return;
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(viewId).classList.remove('hidden');
  });
});

// ── Mock-col tabs (Mock Response / Throttle / Block) ─────────────────────
document.querySelectorAll('.mock-tab[data-mock-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mock-tab[data-mock-tab]').forEach(b => b.classList.remove('mock-tab--active'));
    btn.classList.add('mock-tab--active');
    const tab = btn.dataset.mockTab;
    document.getElementById('mockPanelResponse').classList.toggle('mock-panel--hidden', tab !== 'mock-response');
    document.getElementById('mockPanelThrottle').classList.toggle('mock-panel--hidden', tab !== 'throttle');
    document.getElementById('mockPanelBlock').classList.toggle('mock-panel--hidden', tab !== 'block');
    const resetBtn = document.getElementById('resetOrigBtn');
    if (resetBtn) resetBtn.style.display = tab === 'mock-response' ? '' : 'none';
  });
});

// ── Response sub-tabs (Response / Request) ────────────────────────────────
document.querySelectorAll('.resp-tab[data-body-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!selectedCall) return;
    activeBodyTab = btn.dataset.bodyTab;
    document.querySelectorAll('.resp-tab[data-body-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderActiveTree(selectedCall);
  });
});

function clearLog() {
  calls = [];
  selectedCall = null;
  autoScrollEnabled = true;
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
  if (e.ctrlKey && e.key === 'f' && editorMode === 'tree') { e.preventDefault(); openTreeSearch(); }
});

callListEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const items = [...callListEl.querySelectorAll('.call')];
  if (!items.length) return;
  const currentIdx = items.findIndex(el => el.classList.contains('selected'));
  let nextIdx;
  if (e.key === 'ArrowDown') {
    nextIdx = currentIdx === -1 ? 0 : Math.min(currentIdx + 1, items.length - 1);
  } else {
    nextIdx = currentIdx === -1 ? items.length - 1 : Math.max(currentIdx - 1, 0);
  }
  items[nextIdx].click();
  items[nextIdx].scrollIntoView({ block: 'nearest' });
});

let filterDebounceId = null;
filterInput.addEventListener('input', () => {
  clearTimeout(filterDebounceId);
  filterDebounceId = setTimeout(() => {
    filterText = filterInput.value.trim().toLowerCase();
    renderCallList();
  }, 120);
});

// ── Port messages ──────────────────────────────────────────────────────────
// Handled by onPortMessage (registered in connectPort above).

// ── Call list ──────────────────────────────────────────────────────────────
function visibleCalls() {
  return filterText ? calls.filter(c => c.url.toLowerCase().includes(filterText)) : calls;
}

function buildCallElement(c) {
  const el = document.createElement('div');
  const dotCls = c.status >= 500 ? 'err' : c.status >= 400 ? 'warn' : c.status >= 300 ? 'redirect' : c.status ? 'ok' : 'pending';
  const statusCls = c.status >= 500 ? 'err' : c.status >= 400 ? 'warn' : c.status >= 300 ? 'redirect' : 'ok';
  const timing = c.mocked ? 'mocked' : c.durationMs > 0 ? `${c.durationMs}ms` : '—';
  const timingSlow = c.durationMs > 300 ? ' call-timing--slow' : '';
  const key = `${c.method} ${c.url}`;
  const isMocked = c.mocked || !!mocks[key];
  const method = esc(c.method || 'GET');
  el.className = 'call' + (isMocked ? ' mocked' : '') + (selectedCall === c ? ' selected' : '');
  el.innerHTML = `
    <div class="call-left-accent"></div>
    <div class="call-content">
      <div class="call-row1">
        <span class="status-dot status-dot--${dotCls}"></span>
        <span class="method-badge method-badge--${method}">${method}</span>
        <span class="call-status call-status--${statusCls}">${c.status || '—'}</span>
        <span class="call-timing-spacer"></span>
        <span class="call-timing${timingSlow}">${timing}</span>
      </div>
      <div class="call-row2">
        <span class="call-url" title="${esc(c.url)}">${urlPath(c.url)}</span>
      </div>
    </div>
    <button class="curl-btn" title="Copy as cURL">⧉ cURL</button>
  `;
  el.querySelector('.curl-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    navigator.clipboard.writeText(buildCurl(c)).then(() => {
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '⧉ cURL'; btn.classList.remove('copied'); }, 1500);
    });
  });
  el.addEventListener('click', () => {
    if (selectedCallEl) selectedCallEl.classList.remove('selected');
    selectedCallEl = el;
    selectedCall = c;
    el.classList.add('selected');
    renderDetail(c);
    callListEl.focus();
  });
  return el;
}

function renderCallList() {
  selectedCallEl = null;
  const list = visibleCalls();
  callListEl.innerHTML = '';

  callCountEl.textContent = list.length + (list.length === 1 ? ' call' : ' calls');

  if (!list.length) {
    callListEl.innerHTML = '<div class="list-empty">No API calls yet — make a request on the page.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  (sortNewestBottom ? list : [...list].reverse()).forEach(c => {
    const el = buildCallElement(c);
    if (selectedCall === c) selectedCallEl = el;
    frag.appendChild(el);
  });
  callListEl.appendChild(frag);

  if (sortNewestBottom && autoScrollEnabled) {
    callListEl.scrollTop = callListEl.scrollHeight;
  }
}

function appendSingleCall(c) {
  const empty = callListEl.querySelector('.list-empty');
  if (empty) empty.remove();

  const visible = visibleCalls();
  callCountEl.textContent = visible.length + (visible.length === 1 ? ' call' : ' calls');

  if (filterText && !c.url.toLowerCase().includes(filterText)) return;

  const el = buildCallElement(c);
  if (sortNewestBottom) {
    callListEl.appendChild(el);
    if (autoScrollEnabled) callListEl.scrollTop = callListEl.scrollHeight;
  } else {
    callListEl.insertBefore(el, callListEl.firstChild);
  }
}

// ── Detail rendering ───────────────────────────────────────────────────────
function showEmptyDetail() {
  detailEmpty.style.display = '';
  detailContent.classList.add('hidden');
  copyAsCurlBtn.style.display = 'none';
}

function renderDetail(c) {
  detailEmpty.style.display = 'none';
  detailContent.classList.remove('hidden');

  // Reset body tab to Response on every new call selection
  activeBodyTab = 'response';
  document.querySelectorAll('.resp-tab[data-body-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.bodyTab === 'response');
  });

  // Header
  const statusCls = c.status >= 500 ? 'err' : c.status >= 400 ? 'warn' : c.status >= 300 ? 'info' : 'ok';
  const statusLabel = c.status
    ? (c.status >= 500 ? `${c.status} Error` : c.status >= 400 ? `${c.status}` : c.status >= 300 ? `${c.status}` : `${c.status} OK`)
    : '—';
  const method = esc(c.method || 'GET');
  const meta = c.durationMs > 0 ? `${c.durationMs}ms` : c.mocked ? 'mocked' : '—';
  detailHeader.innerHTML = `
    <span class="req-method-badge method-badge--${method}">${method}</span>
    <span class="req-url" title="${esc(c.url)}">${urlPath(c.url)}</span>
    <span class="req-status-badge req-status-badge--${statusCls}">${statusLabel}</span>
    <span class="req-meta">${meta}</span>
  `;

  renderActiveTree(c);

  // Mock editor
  renderMockPanel(c);
}

const expandAllBtn   = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const copyAsCurlBtn  = document.getElementById('copyAsCurlBtn');
expandAllBtn.addEventListener('click', () => {
  jsonTree.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
});
collapseAllBtn.addEventListener('click', () => {
  jsonTree.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
});
copyAsCurlBtn.addEventListener('click', () => {
  if (!selectedCall) return;
  navigator.clipboard.writeText(buildCurl(selectedCall)).then(() => {
    copyAsCurlBtn.textContent = '✓ Copied';
    copyAsCurlBtn.classList.add('tiny-btn--copied');
    setTimeout(() => {
      copyAsCurlBtn.textContent = '⧉ cURL';
      copyAsCurlBtn.classList.remove('tiny-btn--copied');
    }, 2000);
  });
});

function renderQueryParams(url) {
  let params;
  try {
    params = [...new URL(url).searchParams.entries()];
  } catch {
    params = [];
  }
  if (!params.length) {
    jsonTree.innerHTML = '<span class="empty">No request body</span>';
    return;
  }
  const rows = params.map(([k, v]) =>
    `<tr><td class="qp-key">${esc(k)}</td><td class="qp-val">${esc(v)}</td></tr>`
  ).join('');
  jsonTree.innerHTML =
    `<div class="qp-label">Query Parameters</div>` +
    `<table class="qp-table"><tbody>${rows}</tbody></table>`;
}

function renderActiveTree(c) {
  copyAsCurlBtn.style.display = '';
  if (activeBodyTab === 'request') {
    if (!c.requestBody || !c.requestBody.trim()) {
      expandAllBtn.style.display  = 'none';
      collapseAllBtn.style.display = 'none';
      renderQueryParams(c.url);
      return;
    }
    renderJsonTree(c.requestBody);
  } else {
    renderJsonTree(c.responseBody);
  }

  // Show expand/collapse only when the tree has collapsible nodes (valid JSON)
  const hasTree = jsonTree.querySelector('details') !== null;
  expandAllBtn.style.display  = hasTree ? '' : 'none';
  collapseAllBtn.style.display = hasTree ? '' : 'none';
}

// ── JSON tree ──────────────────────────────────────────────────────────────
const JSON_TREE_SIZE_LIMIT = 80_000; // chars — beyond this, tree render freezes the panel

function renderJsonTree(raw) {
  if (!raw || !raw.trim()) {
    jsonTree.innerHTML = '<span class="empty">(empty)</span>';
    return;
  }
  if (raw.length > JSON_TREE_SIZE_LIMIT) {
    jsonTree.innerHTML =
      `<div style="padding:6px 0;color:#6b7280;font-size:11px">` +
      `Response too large to render as tree (${Math.round(raw.length / 1024)}KB — limit ${JSON_TREE_SIZE_LIMIT / 1024}KB).</div>` +
      `<pre style="margin:0;color:#6b7280;font-size:11px;white-space:pre-wrap;overflow:auto;max-height:320px">${esc(raw.slice(0, 10000))}` +
      (raw.length > 10000 ? `\n… [${Math.round((raw.length - 10000) / 1024)}KB more not shown]` : '') +
      `</pre>`;
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

  if (mockActiveBadge) {
    mockActiveBadge.classList.toggle('hidden', !isEnabled);
  }
  mockStatusEl.value = existing ? existing.status : (c.status || 200);

  // Only reset content when switching to a different call.
  // Preserves in-progress edits when mocks-update fires mid-edit.
  if (currentMockCallId !== String(c.id)) {
    const body = existing ? existing.body : tryPretty(c.responseBody);
    setMockContent(body); // always keep tree state in sync
    currentMockCallId = String(c.id);
    lastMockPanelState = ''; // force action-bar rebuild on call switch
    if (editorMode === 'codemirror') {
      ensureCmInitialized();
      cmSetValue(body);
    } else {
      renderMockContentArea();
    }
  }

  // Actions bar — skip rebuild if mock existence/enabled state hasn't changed
  const newMockState = `${key}:${!!existing}:${isEnabled}`;
  if (newMockState === lastMockPanelState) return;
  lastMockPanelState = newMockState;

  mockActionsEl.innerHTML = '';
  const saveBtn = makeBtn('primary', existing ? 'Update Mock' : 'Save Mock', async () => {
    saveBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'SAVE_MOCK',
        payload: {
          method: c.method, url: c.url,
          status: parseInt(mockStatusEl.value, 10) || 200,
          body: getMockBody(),
          enabled: true,
        },
      });
    } catch { void chrome.runtime.lastError; }
    saveBtn.disabled = false;
  });
  mockActionsEl.appendChild(saveBtn);

  if (existing) {
    const spacer = document.createElement('div');
    spacer.className = 'actions-flex-spacer';
    mockActionsEl.appendChild(spacer);

    const toggleBtn = makeBtn(isEnabled ? 'danger' : '', isEnabled ? 'Disable' : 'Enable', async () => {
      toggleBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: 'TOGGLE_MOCK', key, enabled: !isEnabled });
      } catch { void chrome.runtime.lastError; }
      toggleBtn.disabled = false;
    });
    mockActionsEl.appendChild(toggleBtn);

    const delBtn = makeBtn('', 'Delete', async () => {
      if (!confirm(`Delete mock for ${c.method} ${c.url}?`)) return;
      try { await chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key }); } catch { void chrome.runtime.lastError; }
    });
    mockActionsEl.appendChild(delBtn);
  }
}

function makeBtn(cls, label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn' + (cls ? ` ${cls}` : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ── Reset button ───────────────────────────────────────────────────────────
resetOrigBtn.addEventListener('click', () => {
  if (!selectedCall) return;
  currentMockCallId = null;
  const body = tryPretty(selectedCall.responseBody);
  setMockContent(body);
  if (editorMode === 'codemirror') {
    ensureCmInitialized();
    cmSetValue(body);
  } else {
    renderMockContentArea();
  }
  jsonErrorEl.classList.add('hidden');
});

// ── Mocks list tab ─────────────────────────────────────────────────────────
function updateBulkButtons(count) {
  const off = count === 0;
  enableAllBtn.disabled  = off;
  disableAllBtn.disabled = off;
  deleteAllBtn.disabled  = off;
}

enableAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ENABLE_ALL_MOCKS' }, () => void chrome.runtime.lastError);
});

disableAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DISABLE_ALL_MOCKS' }, () => void chrome.runtime.lastError);
});

deleteAllBtn.addEventListener('click', () => {
  const count = Object.keys(mocks).length;
  if (!confirm(`Delete all ${count} mock${count !== 1 ? 's' : ''}? This cannot be undone.`)) return;
  chrome.runtime.sendMessage({ type: 'DELETE_ALL_MOCKS' }, () => void chrome.runtime.lastError);
});

function buildMockCard(key, m) {
  const card = document.createElement('div');
  card.className = 'mock-card';
  card.dataset.mockKey = key;
  card.dataset.savedAt = String(m.savedAt);
  card.innerHTML = `
    <div class="mock-card-head">
      <span class="method-badge method-badge--${esc(m.method)}">${esc(m.method)}</span>
      <span class="mock-card-url" title="${esc(m.url)}">${esc(m.url)}</span>
      <span class="tab-badge">${m.status}</span>
      <div class="switch ${m.enabled ? 'on' : ''}" data-key="${esc(key)}" title="${m.enabled ? 'Disable' : 'Enable'}"></div>
      <button class="mock-chevron" data-key="${esc(key)}" title="View / edit mock body">›</button>
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
    try { await chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key: k }); } catch { void chrome.runtime.lastError; }
  });
  card.querySelector('.mock-chevron').addEventListener('click', e => {
    const k = e.currentTarget.dataset.key;
    if (openMockKey === k) { closeMockDrawer(); } else { openMockDrawer(k); }
  });
  return card;
}

function renderMockList() {
  const mockListEl = document.getElementById('mockList');
  const keys = Object.keys(mocks);
  mockCountEl.textContent = keys.length;
  updateBulkButtons(keys.length);

  if (!keys.length) {
    openMockKey = null;
    mockListEl.innerHTML = '<div class="list-empty">No mocks saved yet.<br>Click a call → "Save as Mock".</div>';
    return;
  }

  // Build a Map of existing cards in one pass, removing stale ones along the way
  const cardMap = new Map();
  mockListEl.querySelectorAll('[data-mock-key]').forEach(card => {
    const k = card.dataset.mockKey;
    if (!mocks[k]) { card.remove(); } else { cardMap.set(k, card); }
  });

  // Update existing cards or insert new ones — O(1) lookup via cardMap
  keys.forEach(key => {
    const m = mocks[key];
    const existing = cardMap.get(key);
    if (existing) {
      if (existing.dataset.savedAt !== String(m.savedAt)) {
        // Mock body/status changed — replace the whole card so badge and timestamp stay fresh
        const newCard = buildMockCard(key, m);
        mockListEl.replaceChild(newCard, existing);
        cardMap.set(key, newCard);
      } else {
        // Toggle-only update — patch the switch in-place
        const sw = existing.querySelector('.switch');
        if (sw) {
          sw.className = `switch${m.enabled ? ' on' : ''}`;
          sw.title = m.enabled ? 'Disable' : 'Enable';
        }
      }
    } else {
      mockListEl.appendChild(buildMockCard(key, m));
    }
  });

  // Re-attach drawer if a key was open (preserves unsaved edits across updates)
  if (openMockKey && mocks[openMockKey] && drawerEl) {
    const card = cardMap.get(openMockKey) ?? mockListEl.querySelector(`[data-mock-key="${CSS.escape(openMockKey)}"]`);
    if (card) {
      card.querySelector('.mock-chevron').classList.add('open');
      if (!drawerEl.parentElement) card.appendChild(drawerEl);
    }
  } else if (openMockKey && !mocks[openMockKey]) {
    openMockKey = null;
  }
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

// ── Open in IDE settings ───────────────────────────────────────────────────
const IDE_STORAGE_KEY = 'api-mocker-ide';
let ideSettings = { enabled: true, ide: 'vscode' };

function saveIdeSettings() {
  chrome.storage.local.set({ [IDE_STORAGE_KEY]: ideSettings });
}

function renderIdeSettings() {
  const toggle = document.getElementById('ideToggle');
  const select = document.getElementById('ideSelect');
  if (toggle) toggle.className = 'switch' + (ideSettings.enabled ? ' on' : '');
  if (select) select.value = ideSettings.ide || 'vscode';
}

document.getElementById('ideToggle')?.addEventListener('click', () => {
  ideSettings.enabled = !ideSettings.enabled;
  document.getElementById('ideToggle').className = 'switch' + (ideSettings.enabled ? ' on' : '');
  saveIdeSettings();
});

document.getElementById('ideSelect')?.addEventListener('change', e => {
  ideSettings.ide = e.target.value;
  saveIdeSettings();
});

// Load IDE settings on init
chrome.storage.local.get(IDE_STORAGE_KEY, result => {
  ideSettings = result[IDE_STORAGE_KEY] || { enabled: true, ide: 'vscode' };
  renderIdeSettings();
});


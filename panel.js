// ── Connection ─────────────────────────────────────────────────────────────
const tabId = chrome.devtools.inspectedWindow.tabId;
const port  = chrome.runtime.connect({ name: `panel:${tabId}` });

// ── State ──────────────────────────────────────────────────────────────────
let calls = [];
let mocks = {};
let selectedCall = null;
let filterText = '';
let currentPanelDomain = '';
let activeBodyTab = 'response'; // 'response' | 'request'

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
    { tag: tags.propertyName,  color: '#7c3aed' },
    { tag: tags.string,        color: '#047857' },
    { tag: tags.number,        color: '#1d4ed8' },
    { tag: tags.bool,          color: '#b45309' },
    { tag: tags.null,          color: '#b91c1c' },
    { tag: tags.punctuation,   color: '#374151' },
    { tag: tags.bracket,       color: '#374151', fontWeight: 'bold' },
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
          '&': { height: '100%', background: '#f8f9ff', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', lineHeight: '1.6' },
          '.cm-content': { padding: '8px 0', caretColor: '#111827' },
          '.cm-gutters': { background: '#f0f0f8', border: 'none', borderRight: '1px solid #e5e7eb' },
          '.cm-lineNumbers .cm-gutterElement': { color: '#9ca3af', minWidth: '28px', padding: '0 6px 0 4px' },
          '.cm-foldGutter .cm-gutterElement': { color: '#9ca3af', padding: '0 4px', cursor: 'pointer' },
          '.cm-activeLine': { background: 'rgba(79,70,229,0.04)' },
          '.cm-activeLineGutter': { background: 'rgba(79,70,229,0.04)' },
          '.cm-matchingBracket': { background: 'rgba(79,70,229,0.15)', borderRadius: '2px', outline: 'none' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(79,70,229,0.2)' },
          '.cm-cursor': { borderLeftColor: '#111827' },
          '.cm-searchMatch': { background: 'rgba(253,224,71,0.5)', borderRadius: '2px' },
          '.cm-searchMatch.cm-searchMatch-selected': { background: 'rgba(251,146,60,0.5)' },
          '.cm-panels': { background: '#f0f0f8', borderBottom: '1px solid #e5e7eb' },
          '.cm-panel.cm-search': { padding: '4px 8px', fontSize: '11px', fontFamily: 'ui-monospace, Consolas, monospace' },
          '.cm-panel.cm-search input': { border: '1px solid #d1d5db', borderRadius: '3px', padding: '2px 5px', fontSize: '11px' },
          '.cm-panel.cm-search button': { padding: '2px 7px', border: '1px solid #d1d5db', borderRadius: '3px', background: '#fff', fontSize: '11px', cursor: 'pointer', marginLeft: '4px' },
          '.cm-foldPlaceholder': { background: '#e0d9f7', border: '1px solid #c4b5fd', color: '#5b21b6', borderRadius: '3px', padding: '0 4px', cursor: 'pointer' },
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
const callListEl    = document.getElementById('callList');
const callListCol   = document.getElementById('callListCol');
const detailEmpty   = document.getElementById('detailEmpty');
const detailContent = document.getElementById('detailContent');
const detailHeader  = document.getElementById('detailHeader');
const jsonTree      = document.getElementById('jsonTree');
const mockColTitle  = document.getElementById('mockColTitle');
const mockStatusEl  = document.getElementById('mockStatus');
const mockActionsEl = document.getElementById('mockActions');
const jsonErrorEl   = document.getElementById('jsonError');
const callCountEl   = document.getElementById('callCount');
const mockCountEl   = document.getElementById('mockCount');
const filterInput   = document.getElementById('filterInput');
const resetOrigBtn  = document.getElementById('resetOrigBtn');
const enableAllBtn  = document.getElementById('enableAllBtn');
const disableAllBtn = document.getElementById('disableAllBtn');
const deleteAllBtn  = document.getElementById('deleteAllBtn');
const sortToggleBtn = document.getElementById('sortToggleBtn');

// ── Sort order ─────────────────────────────────────────────────────────────
const SORT_KEY = 'api-mocker-sort';
let sortNewestBottom = localStorage.getItem(SORT_KEY) !== 'oldest';
let autoScrollEnabled = true;

function updateSortBtn() {
  sortToggleBtn.textContent = sortNewestBottom ? '↓ Newest' : '↑ Oldest';
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
    { tag: tags.propertyName, color: '#7c3aed' },
    { tag: tags.string,       color: '#047857' },
    { tag: tags.number,       color: '#1d4ed8' },
    { tag: tags.bool,         color: '#b45309' },
    { tag: tags.null,         color: '#b91c1c' },
    { tag: tags.punctuation,  color: '#374151' },
    { tag: tags.bracket,      color: '#374151', fontWeight: 'bold' },
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
          '&': { height: '100%', background: '#f8f9ff', fontSize: '12px' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', lineHeight: '1.6' },
          '.cm-content': { padding: '8px 0', caretColor: '#111827' },
          '.cm-gutters': { background: '#f0f0f8', border: 'none', borderRight: '1px solid #e5e7eb' },
          '.cm-lineNumbers .cm-gutterElement': { color: '#9ca3af', minWidth: '28px', padding: '0 6px 0 4px' },
          '.cm-foldGutter .cm-gutterElement': { color: '#9ca3af', padding: '0 4px', cursor: 'pointer' },
          '.cm-activeLine': { background: 'rgba(79,70,229,0.04)' },
          '.cm-activeLineGutter': { background: 'rgba(79,70,229,0.04)' },
          '.cm-matchingBracket': { background: 'rgba(79,70,229,0.15)', borderRadius: '2px', outline: 'none' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(79,70,229,0.2)' },
          '.cm-cursor': { borderLeftColor: '#111827' },
          '.cm-searchMatch': { background: 'rgba(253,224,71,0.5)', borderRadius: '2px' },
          '.cm-searchMatch.cm-searchMatch-selected': { background: 'rgba(251,146,60,0.5)' },
          '.cm-panels': { background: '#f0f0f8', borderBottom: '1px solid #e5e7eb' },
          '.cm-panel.cm-search': { padding: '4px 8px', fontSize: '11px', fontFamily: 'ui-monospace, Consolas, monospace' },
          '.cm-panel.cm-search input': { border: '1px solid #d1d5db', borderRadius: '3px', padding: '2px 5px', fontSize: '11px' },
          '.cm-panel.cm-search button': { padding: '2px 7px', border: '1px solid #d1d5db', borderRadius: '3px', background: '#fff', fontSize: '11px', cursor: 'pointer', marginLeft: '4px' },
          '.cm-foldPlaceholder': { background: '#e0d9f7', border: '1px solid #c4b5fd', color: '#5b21b6', borderRadius: '3px', padding: '0 4px', cursor: 'pointer' },
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

// ── Tabs (top-level: Calls / Mocks) ───────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab + 'View').classList.remove('hidden');
  });
});

// ── Body tabs (Response Body / Request Body) ───────────────────────────────
document.querySelectorAll('.body-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!selectedCall) return;
    activeBodyTab = btn.dataset.bodyTab;
    document.querySelectorAll('.body-tab').forEach(b => b.classList.remove('active'));
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

  (sortNewestBottom ? list : [...list].reverse()).forEach(c => {
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
      callListEl.focus();
    });
    callListEl.appendChild(el);
  });

  if (sortNewestBottom && autoScrollEnabled) {
    callListEl.scrollTop = callListEl.scrollHeight;
  }
}

// ── Detail rendering ───────────────────────────────────────────────────────
function showEmptyDetail() {
  detailEmpty.style.display = '';
  detailContent.classList.add('hidden');
}

function renderDetail(c) {
  detailEmpty.style.display = 'none';
  detailContent.classList.remove('hidden');

  // Reset body tab to Response on every new call selection
  activeBodyTab = 'response';
  document.querySelectorAll('.body-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.bodyTab === 'response');
  });

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

  renderActiveTree(c);

  // Mock editor
  renderMockPanel(c);
}

function renderActiveTree(c) {
  const expandAllBtn  = document.getElementById('expandAllBtn');
  const collapseAllBtn = document.getElementById('collapseAllBtn');

  if (activeBodyTab === 'request') {
    if (!c.requestBody || !c.requestBody.trim()) {
      jsonTree.innerHTML = '<span class="empty">No request body</span>';
      expandAllBtn.style.display  = 'none';
      collapseAllBtn.style.display = 'none';
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

  expandAllBtn.onclick = () => {
    jsonTree.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
  };
  collapseAllBtn.onclick = () => {
    jsonTree.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
  };
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

  // Only reset content when switching to a different call.
  // Preserves in-progress edits when mocks-update fires mid-edit.
  if (currentMockCallId !== String(c.id)) {
    const body = existing ? existing.body : tryPretty(c.responseBody);
    setMockContent(body); // always keep tree state in sync
    currentMockCallId = String(c.id);
    if (editorMode === 'codemirror') {
      ensureCmInitialized();
      cmSetValue(body);
    } else {
      renderMockContentArea();
    }
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
        body: getMockBody(),
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

  mockListEl.innerHTML = '';
  keys.forEach(key => {
    const m = mocks[key];
    const card = document.createElement('div');
    card.className = 'mock-card';
    card.dataset.mockKey = key;
    card.innerHTML = `
      <div class="mock-card-head">
        <span class="cm ${esc(m.method)}">${esc(m.method)}</span>
        <span class="mock-card-url" title="${esc(m.url)}">${esc(m.url)}</span>
        <span class="badge">${m.status}</span>
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
      await chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key: k },
        () => void chrome.runtime.lastError);
    });
    card.querySelector('.mock-chevron').addEventListener('click', e => {
      const k = e.currentTarget.dataset.key;
      if (openMockKey === k) { closeMockDrawer(); } else { openMockDrawer(k); }
    });
    mockListEl.appendChild(card);
  });

  // Re-attach drawer if a key was open (preserves unsaved edits across re-renders)
  if (openMockKey && mocks[openMockKey] && drawerEl) {
    const card = mockListEl.querySelector(`[data-mock-key="${CSS.escape(openMockKey)}"]`);
    if (card) {
      card.querySelector('.mock-chevron').classList.add('open');
      card.appendChild(drawerEl);
    }
  } else if (openMockKey && !mocks[openMockKey]) {
    openMockKey = null; // mock was deleted
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


// Floating widget injected on every page. Runs in ISOLATED world.
// Only renders when the extension is enabled for this domain.
(() => {
  if (document.getElementById('__api-mocker-fab')) return;

  let callCount = 0;
  let mockCount = 0;
  let allEnabled = true;
  let panelOpen = false;
  let mounted = false;
  const MAX_RECENT = 5;
  let recentCalls = [];

  // ── Build DOM (not mounted yet) ───────────────────────────────────────────
  const host = document.createElement('div');
  host.id = '__api-mocker-fab';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    #fab {
      position: fixed; bottom: 22px; right: 22px; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px;
      background: #312e81; color: #fff;
      padding: 7px 12px; border-radius: 20px;
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      cursor: pointer; font: 12px/1 -apple-system, Segoe UI, Roboto, sans-serif;
      user-select: none; transition: background .15s;
    }
    #fab:hover { background: #3730a3; }
    #fab.has-active { background: #4338ca; }
    #badge {
      background: #818cf8; color: #fff;
      font-size: 11px; font-weight: 700;
      padding: 1px 6px; border-radius: 9px; min-width: 20px; text-align: center;
    }
    #badge.mocked { background: #f59e0b; color: #1c1917; }
    #panel {
      position: fixed; bottom: 68px; right: 22px; z-index: 2147483647;
      width: 360px; background: #1e1e2e; color: #cdd6f4;
      border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
      font: 12px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
      overflow: hidden; display: none; flex-direction: column;
      max-height: 400px;
    }
    #panel.open { display: flex; }
    .p-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: #181825; border-bottom: 1px solid #313244;
      font-weight: 600; font-size: 12px;
    }
    .p-head-right { display: flex; align-items: center; gap: 8px; }
    .toggle-all {
      font-size: 11px; padding: 3px 8px; border-radius: 4px; cursor: pointer;
      border: 1px solid #585b70; background: transparent; color: #cdd6f4;
    }
    .toggle-all.on { border-color: #a6e3a1; color: #a6e3a1; }
    .close-btn { background: none; border: none; color: #6c7086; cursor: pointer; font-size: 16px; line-height: 1; }
    .calls { overflow-y: auto; flex: 1; }
    .call-row {
      display: grid; grid-template-columns: 48px 36px 1fr 40px;
      gap: 6px; padding: 5px 12px; border-bottom: 1px solid #181825;
      align-items: center; font-size: 11px;
    }
    .call-row.mocked { border-left: 3px solid #f59e0b; padding-left: 9px; }
    .method { font-weight: 700; }
    .method.GET { color: #a6e3a1; }
    .method.POST { color: #89b4fa; }
    .method.PUT, .method.PATCH { color: #fab387; }
    .method.DELETE { color: #f38ba8; }
    .status.ok { color: #a6e3a1; } .status.err { color: #f38ba8; } .status.warn { color: #fab387; }
    .url-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bac2de; }
    .dur { color: #6c7086; text-align: right; font-variant-numeric: tabular-nums; }
    .empty { padding: 20px 12px; color: #6c7086; text-align: center; }
    .p-foot {
      padding: 6px 12px; border-top: 1px solid #313244; color: #6c7086;
      font-size: 11px; text-align: center;
    }
  `;

  const fab = document.createElement('div');
  fab.id = 'fab';
  fab.innerHTML = `<span id="fabLabel">API Mocker</span><span id="badge">0</span>`;

  const panel = document.createElement('div');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="p-head">
      <span>Recent Calls</span>
      <div class="p-head-right">
        <button class="toggle-all" id="toggleAll">Mocks: OFF</button>
        <button class="close-btn" id="closeBtn">✕</button>
      </div>
    </div>
    <div class="calls" id="callRows"></div>
    <div class="p-foot">Open DevTools → API Mocker panel for full editor</div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(panel);
  shadow.appendChild(fab);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const badgeEl     = shadow.getElementById('badge');
  const callRowsEl  = shadow.getElementById('callRows');
  const toggleAllBtn = shadow.getElementById('toggleAll');
  const closeBtn    = shadow.getElementById('closeBtn');

  // ── Mount / unmount ───────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    mounted = true;
    document.documentElement.appendChild(host);
    renderCalls();
    updateToggleBtn();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    panelOpen = false;
    panel.classList.remove('open');
    host.remove();
  }

  // ── Events ────────────────────────────────────────────────────────────────
  fab.addEventListener('click', () => {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panelOpen = false;
    panel.classList.remove('open');
  });

  toggleAllBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const bridge = window.__apiMockerBridge;
    if (!bridge) return;
    const currentMocks = bridge.getMocks();
    allEnabled = !allEnabled;
    for (const key of Object.keys(currentMocks)) {
      await bridge.toggleMock(key, allEnabled);
    }
    updateToggleBtn();
  });

  // ── Domain status ─────────────────────────────────────────────────────────
  window.addEventListener('api-mocker:status', (e) => {
    if (e.detail && e.detail.enabled) {
      mount();
    } else {
      unmount();
    }
  });

  // ── Listen for calls ──────────────────────────────────────────────────────
  window.addEventListener('api-mocker:call', (e) => {
    const c = e.detail;
    callCount++;
    badgeEl.textContent = callCount;
    recentCalls.unshift(c);
    if (recentCalls.length > MAX_RECENT) recentCalls.pop();
    renderCalls();
    badgeEl.classList.add('mocked');
    setTimeout(() => badgeEl.classList.remove('mocked'), 400);
  });

  window.addEventListener('api-mocker:mocks', (e) => {
    const m = e.detail || {};
    mockCount = Object.keys(m).length;
    const anyOn = Object.values(m).some(v => ['response', 'throttle', 'block'].some(s => v[s] && v[s].enabled));
    allEnabled = anyOn;
    updateToggleBtn();
  });

  // ── Render ────────────────────────────────────────────────────────────────
  function renderCalls() {
    if (!recentCalls.length) {
      callRowsEl.innerHTML = '<div class="empty">No calls yet — make a request.</div>';
      return;
    }
    callRowsEl.innerHTML = recentCalls.map(c => {
      const sc = c.status >= 400 ? 'err' : c.status >= 300 ? 'warn' : 'ok';
      const ms = c.durationMs > 0 ? `${c.durationMs}ms` : c.mocked ? '~' : '';
      return `
        <div class="call-row${c.mocked ? ' mocked' : ''}">
          <span class="method ${c.method}">${c.method}</span>
          <span class="status ${sc}">${c.status || '—'}</span>
          <span class="url-cell" title="${esc(c.url)}">${shortPath(c.url)}</span>
          <span class="dur">${ms}</span>
        </div>
      `;
    }).join('');
  }

  function updateToggleBtn() {
    toggleAllBtn.textContent = `Mocks: ${allEnabled && mockCount > 0 ? 'ON' : 'OFF'}`;
    toggleAllBtn.classList.toggle('on', allEnabled && mockCount > 0);
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function shortPath(url) {
    try { return esc(new URL(url).pathname); } catch { return esc(url); }
  }

  window.addEventListener('api-mocker:reset', () => {
    callCount = 0;
    recentCalls = [];
    badgeEl.textContent = '0';
    renderCalls();
  });
})();

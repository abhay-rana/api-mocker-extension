// Floating widget injected on every page. Runs in ISOLATED world.
// Only renders when the extension is enabled for this domain.
(() => {
  if (document.getElementById('__api-mocker-fab')) return;

  let interceptedCount = 0; // mocked + slow + blocked only (badge)
  let mockedCount  = 0;
  let slowCount    = 0;
  let blockedCount = 0;
  let mockCount    = 0;
  let allEnabled   = true;
  let panelOpen    = false;
  let mounted      = false;
  const MAX_RECENT = 5;
  let recentCalls  = []; // intercepted calls only

  // ── Build DOM (not mounted yet) ───────────────────────────────────────────
  const host = document.createElement('div');
  host.id = '__api-mocker-fab';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* ── FAB pill ─────────────────────────────────────────────────────────── */
    #fab {
      position: fixed; bottom: 22px; right: 22px; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px;
      background: #141625; color: #E2E8F0;
      padding: 0 12px; height: 32px; border-radius: 20px;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
      cursor: pointer; font: 13px/1 Inter, -apple-system, Segoe UI, sans-serif;
      user-select: none; border: 1px solid #2A2D45;
    }
    #fab:hover { background: #1A1D2E; }
    .fab-dot { width: 8px; height: 8px; border-radius: 50%; background: #3B82F6; flex-shrink: 0; }
    #badge {
      background: #3B82F6; color: #fff;
      font-size: 10px; font-weight: 600;
      padding: 1px 6px; border-radius: 8px; min-width: 18px; text-align: center;
    }

    /* ── Panel ────────────────────────────────────────────────────────────── */
    #panel {
      position: fixed; bottom: 62px; right: 22px; z-index: 2147483647;
      width: 340px;
      background: #1A1D2E; color: #E2E8F0;
      border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.6);
      font: 11px/1.4 Inter, -apple-system, Segoe UI, sans-serif;
      overflow: hidden; display: none; flex-direction: column;
      border: 1px solid #2A2D45;
    }
    #panel.open { display: flex; }

    /* Header */
    .p-head {
      display: flex; align-items: center;
      padding: 0 14px; height: 44px;
      background: #141625;
      border-bottom: 1px solid #2A2D45;
      gap: 8px;
    }
    .p-head-dot { width: 12px; height: 12px; border-radius: 50%; background: #3B82F6; flex-shrink: 0; }
    .p-head-label { font-size: 13px; color: #E2E8F0; flex: 1; }
    .p-badge {
      background: #3B82F6; color: #fff;
      font-size: 10px; padding: 1px 6px; border-radius: 8px; min-width: 18px;
      text-align: center;
    }
    .pause-btn {
      width: 28px; height: 20px; border-radius: 5px;
      background: #2A2D45; border: none; color: #94A3B8;
      font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .pause-btn:hover { background: #363960; }

    /* Stats chips */
    .p-stats {
      display: flex; align-items: center; gap: 8px;
      padding: 0 14px; height: 32px;
      background: #141625;
      border-bottom: 1px solid #2A2D45;
    }
    .stat-chip {
      display: inline-flex; align-items: center;
      height: 20px; padding: 2px 7px; border-radius: 10px;
      font-size: 10px; white-space: nowrap;
    }
    .stat-chip--mock   { background: #0D2B18; color: #4ADE80; }
    .stat-chip--slow   { background: #2D1F08; color: #FCD34D; }
    .stat-chip--block  { background: #2D0F0F; color: #FCA5A5; }
    .p-stats-empty { font-size: 10px; color: #4B5675; }

    /* Section header */
    .p-section {
      display: flex; align-items: center; gap: 6px;
      padding: 0 14px; height: 26px;
    }
    .p-section-label { font-size: 11px; color: #94A3B8; }
    .p-section-spacer { flex: 1; }
    .live-dot { width: 7px; height: 7px; border-radius: 50%; background: #22C55E; flex-shrink: 0; }
    .live-label { font-size: 10px; color: #4ADE80; }

    /* Call rows */
    .calls { overflow-y: auto; flex: 1; }
    .call-row {
      display: flex; align-items: center; gap: 6px;
      padding: 0 10px; height: 36px;
    }
    .call-row:nth-child(odd)  { background: #1A1D2E; }
    .call-row:nth-child(even) { background: #1E2238; }

    .type-badge {
      display: inline-flex; align-items: center;
      height: 16px; padding: 2px 5px; border-radius: 3px;
      font-size: 9px; flex-shrink: 0;
    }
    .type-badge--mock  { background: #0D2B18; color: #4ADE80; }
    .type-badge--slow  { background: #2D1F08; color: #FCD34D; }
    .type-badge--block { background: #2D0F0F; color: #FCA5A5; }

    .cr-method { font-size: 10px; font-weight: 600; flex-shrink: 0; }
    .cr-method--GET     { color: #60A5FA; }
    .cr-method--POST    { color: #4ADE80; }
    .cr-method--PUT     { color: #FB923C; }
    .cr-method--PATCH   { color: #FB923C; }
    .cr-method--DELETE  { color: #F87171; }
    .cr-method--other   { color: #94A3B8; }

    .cr-url  { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #E2E8F0; font-size: 10px; }
    .cr-status { font-size: 10px; color: #4ADE80; flex-shrink: 0; }
    .cr-status--none   { color: #4B5675; }
    .cr-status--err    { color: #F87171; }
    .cr-dur { font-size: 10px; color: #4B5675; flex-shrink: 0; min-width: 36px; text-align: right; }

    .empty { padding: 20px 14px; color: #4B5675; text-align: center; font-size: 11px; }

    /* Footer */
    .p-foot {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      height: 35px; border-top: 1px solid #2A2D45;
      background: #141625; color: #3B82F6; font-size: 11px; cursor: default;
    }
    .p-foot svg { flex-shrink: 0; }
  `;

  const fab = document.createElement('div');
  fab.id = 'fab';
  fab.innerHTML = `<span class="fab-dot"></span><span>API Mocker</span><span id="badge">0</span>`;

  const panel = document.createElement('div');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="p-head">
      <span class="p-head-dot"></span>
      <span class="p-head-label">API Mocker</span>
      <span class="p-badge" id="panelBadge">0</span>
      <button class="pause-btn" id="pauseBtn">⏸</button>
    </div>
    <div class="p-stats" id="statsRow"></div>
    <div class="p-section">
      <span class="p-section-label">Recent Activity</span>
      <span class="p-section-spacer"></span>
      <span class="live-dot"></span>
      <span class="live-label"> live</span>
    </div>
    <div class="calls" id="callRows"></div>
    <div class="p-foot">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      Open DevTools for full control
    </div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(panel);
  shadow.appendChild(fab);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const badgeEl    = shadow.getElementById('badge');
  const panelBadge = shadow.getElementById('panelBadge');
  const callRowsEl = shadow.getElementById('callRows');
  const statsRow   = shadow.getElementById('statsRow');
  const pauseBtn   = shadow.getElementById('pauseBtn');

  // ── Mount / unmount ───────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    mounted = true;
    document.documentElement.appendChild(host);
    renderStats();
    renderCalls();
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

  pauseBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const bridge = window.__apiMockerBridge;
    if (!bridge) return;
    const currentMocks = bridge.getMocks();
    allEnabled = !allEnabled;
    for (const key of Object.keys(currentMocks)) {
      await bridge.toggleMock(key, allEnabled);
    }
    pauseBtn.textContent = allEnabled ? '⏸' : '▶';
  });

  // ── Domain status ─────────────────────────────────────────────────────────
  window.addEventListener('api-mocker:status', (e) => {
    if (e.detail && e.detail.enabled) { mount(); } else { unmount(); }
  });

  // ── Listen for calls ──────────────────────────────────────────────────────
  window.addEventListener('api-mocker:call', (e) => {
    const c = e.detail;
    const isIntercepted = c.mocked || c.throttled || c.blocked;
    if (!isIntercepted) return; // skip PASS calls entirely

    interceptedCount++;
    if (c.blocked)          blockedCount++;
    else if (c.throttled)   slowCount++;
    else if (c.mocked)      mockedCount++;

    badgeEl.textContent    = interceptedCount;
    panelBadge.textContent = interceptedCount;

    recentCalls.unshift(c);
    if (recentCalls.length > MAX_RECENT) recentCalls.pop();

    renderStats();
    renderCalls();
  });

  window.addEventListener('api-mocker:mocks', (e) => {
    const m = e.detail || {};
    mockCount = Object.keys(m).length;
    allEnabled = Object.values(m).some(v =>
      ['response', 'throttle', 'block'].some(s => v[s] && v[s].enabled)
    );
    pauseBtn.textContent = allEnabled ? '⏸' : '▶';
  });

  // ── Render ────────────────────────────────────────────────────────────────
  function renderStats() {
    const chips = [];
    if (mockedCount)  chips.push(`<span class="stat-chip stat-chip--mock">● ${mockedCount} mocked</span>`);
    if (slowCount)    chips.push(`<span class="stat-chip stat-chip--slow">⌛ ${slowCount} slow</span>`);
    if (blockedCount) chips.push(`<span class="stat-chip stat-chip--block">✕ ${blockedCount} blocked</span>`);
    statsRow.innerHTML = chips.length
      ? chips.join('')
      : '<span class="p-stats-empty">No intercepted calls yet</span>';
  }

  function callType(c) {
    if (c.blocked)        return 'block';
    if (c.throttled)      return 'slow';
    if (c.mocked)         return 'mock';
    return 'mock';
  }

  function callTypeLabel(c) {
    if (c.blocked)   return 'BLKD';
    if (c.throttled) return 'SLOW';
    return 'MOCK';
  }

  function formatDur(c) {
    if (c.blocked) return '—';
    if (!c.durationMs) return '—';
    if (c.durationMs >= 1000) return `${parseFloat((c.durationMs / 1000).toFixed(1))}s`;
    return `${c.durationMs}ms`;
  }

  function methodClass(method) {
    const m = (method || '').toUpperCase();
    return ['GET','POST','PUT','PATCH','DELETE'].includes(m) ? m : 'other';
  }

  function renderCalls() {
    if (!recentCalls.length) {
      callRowsEl.innerHTML = '<div class="empty">No intercepted calls yet.</div>';
      return;
    }
    callRowsEl.innerHTML = recentCalls.map(c => {
      const type    = callType(c);
      const typeLabel = callTypeLabel(c);
      const method  = (c.method || 'GET').toUpperCase();
      const statusHtml = c.blocked
        ? '<span class="cr-status cr-status--none">—</span>'
        : c.status >= 400
          ? `<span class="cr-status cr-status--err">${c.status}</span>`
          : `<span class="cr-status">${c.status || '—'}</span>`;
      return `
        <div class="call-row">
          <span class="type-badge type-badge--${type}">${typeLabel}</span>
          <span class="cr-method cr-method--${methodClass(method)}">${method}</span>
          <span class="cr-url" title="${esc(c.url)}">${shortPath(c.url)}</span>
          ${statusHtml}
          <span class="cr-dur">${formatDur(c)}</span>
        </div>
      `;
    }).join('');
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function shortPath(url) {
    try { return esc(new URL(url).pathname); } catch { return esc(url); }
  }

  window.addEventListener('api-mocker:reset', () => {
    interceptedCount = 0; mockedCount = 0; slowCount = 0; blockedCount = 0;
    recentCalls = [];
    badgeEl.textContent = panelBadge.textContent = '0';
    renderStats();
    renderCalls();
  });
})();

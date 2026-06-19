// Service worker. Owns mock storage, domain enable/disable, and routes messages
// between content scripts (per tab) and DevTools panel ports (per tab).

const STORAGE_KEY = 'mocks';
const DOMAINS_KEY = 'domains'; // { 'hostname:port': true/false }
const MAX_LOG = 250;

const callLog = new Map();    // tabId -> Call[]
const panelPorts = new Map(); // tabId -> port

// ── Storage helpers ──────────────────────────────────────────────────────────

async function loadMocks() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return migrateMocks(r[STORAGE_KEY] || {});
}

// Lazily wrap legacy flat rules { status, body, enabled } into the nested
// composite shape { response: { enabled, status, body } }. Idempotent.
function migrateMocks(mocks) {
  for (const key of Object.keys(mocks)) {
    const m = mocks[key];
    if (!m || typeof m !== 'object') continue;
    const isNested = 'response' in m || 'throttle' in m || 'block' in m;
    if (isNested) continue;
    mocks[key] = {
      method: m.method,
      url: m.url,
      savedAt: m.savedAt || 0,
      response: {
        enabled: m.enabled !== false,
        status: m.status || 200,
        body: m.body ?? '',
      },
    };
  }
  return mocks;
}

// 'always' → unlimited (null); 'x1' → 1; 'x5' → 5
function repeatToRemaining(repeat) {
  if (repeat === 'x1') return 1;
  if (repeat === 'x5') return 5;
  return null; // always
}

// Delete the composite key if it has no remaining sub-rules.
function pruneRule(mocks, key) {
  const m = mocks[key];
  if (m && !m.response && !m.throttle && !m.block) delete mocks[key];
}
async function saveMocks(mocks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: mocks });
}
async function commitMocks(mocks) {
  await saveMocks(mocks);
  await broadcastMocks(mocks);
}

async function loadDomains() {
  const r = await chrome.storage.local.get(DOMAINS_KEY);
  return r[DOMAINS_KEY] || {};
}
async function saveDomains(domains) {
  await chrome.storage.local.set({ [DOMAINS_KEY]: domains });
}

function getDomainFromUrl(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function isDomainEnabled(domain) {
  const domains = await loadDomains();
  return domains[domain] === true;
}

// ── Icon drawing (OffscreenCanvas) ───────────────────────────────────────────

function makeIconImageData(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const r = size * 0.45;
  const cx = size / 2;
  ctx.clearRect(0, 0, size, size);
  // Background circle
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cx, r, 0, Math.PI * 2);
  ctx.fill();
  // "AM" label
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.36)}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AM', cx, cx + 0.5);
  return ctx.getImageData(0, 0, size, size);
}

async function setTabIcon(tabId, enabled) {
  const color = enabled ? '#22c55e' : '#9ca3af';
  try {
    await chrome.action.setIcon({
      tabId,
      imageData: {
        16: makeIconImageData(16, color),
        32: makeIconImageData(32, color),
      },
    });
  } catch (err) { console.warn('[API Mocker] setTabIcon failed:', err); }
}

async function refreshTabIcon(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.startsWith('http')) { setTabIcon(tabId, false); return; }
    const domain = getDomainFromUrl(tab.url);
    const enabled = domain ? await isDomainEnabled(domain) : false;
    setTabIcon(tabId, enabled);
  } catch (err) { console.warn('[API Mocker] refreshTabIcon:', err); }
}

// ── Broadcast helpers ────────────────────────────────────────────────────────

async function broadcastMocks(mocks) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, { type: 'MOCKS_UPDATED', payload: mocks }).catch(() => {});
  }
  for (const p of panelPorts.values()) {
    try { p.postMessage({ type: 'MOCKS_UPDATED', payload: mocks }); } catch {}
  }
}

async function broadcastDomainStatus(domain, enabled) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    if (getDomainFromUrl(t.url) !== domain) continue;
    chrome.tabs.sendMessage(t.id, { type: 'DOMAIN_UPDATED', domain, enabled }).catch(() => {});
    setTabIcon(t.id, enabled);
    const port = panelPorts.get(t.id);
    if (port) {
      try { port.postMessage({ type: 'DOMAIN_STATUS', domain, enabled }); } catch {}
    }
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;
    const tabId = sender.tab && sender.tab.id;

    if (msg.type === 'GET_MOCKS') {
      const mocks = await loadMocks();
      sendResponse({ mocks });
      return;
    }

    if (msg.type === 'GET_DOMAIN_STATUS') {
      const enabled = await isDomainEnabled(msg.domain);
      sendResponse({ enabled });
      return;
    }

    if (msg.type === 'GET_ALL_DOMAINS') {
      const domains = await loadDomains();
      sendResponse({ domains });
      return;
    }

    if (msg.type === 'SET_DOMAIN_STATUS') {
      const domains = await loadDomains();
      // true = enabled, false = saved but paused; delete = remove from list
      domains[msg.domain] = msg.enabled;
      await saveDomains(domains);
      await broadcastDomainStatus(msg.domain, msg.enabled);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_DOMAIN') {
      const domains = await loadDomains();
      delete domains[msg.domain];
      await saveDomains(domains);
      await broadcastDomainStatus(msg.domain, false);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'CALL' && tabId != null) {
      const list = callLog.get(tabId) || [];
      list.push(msg.payload);
      while (list.length > MAX_LOG) list.shift();
      callLog.set(tabId, list);
      const port = panelPorts.get(tabId);
      if (port) {
        try { port.postMessage({ type: 'CALL', payload: msg.payload }); } catch {}
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SAVE_MOCK') {
      const mocks = await loadMocks();
      const m = msg.payload;
      const method = (m.method || 'GET').toUpperCase();
      const key = `${method} ${m.url}`;
      const prev = mocks[key] || {};
      mocks[key] = {
        ...prev,
        method,
        url: m.url,
        savedAt: Date.now(),
        response: {
          enabled: m.enabled !== false,
          status: m.status || 200,
          body: m.body ?? '',
        },
      };
      await commitMocks(mocks);
      sendResponse({ ok: true, key });
      return;
    }

    if (msg.type === 'SAVE_THROTTLE') {
      const mocks = await loadMocks();
      const m = msg.payload;
      const method = (m.method || 'GET').toUpperCase();
      const key = `${method} ${m.url}`;
      const prev = mocks[key] || {};
      mocks[key] = {
        ...prev,
        method,
        url: m.url,
        savedAt: Date.now(),
        throttle: {
          enabled: m.enabled !== false,
          preset: m.preset || 'fast3g',
          delayMs: Number(m.delayMs) || 0,
          repeat: m.repeat || 'always',
          remaining: repeatToRemaining(m.repeat),
        },
      };
      await commitMocks(mocks);
      sendResponse({ ok: true, key });
      return;
    }

    if (msg.type === 'SAVE_BLOCK') {
      const mocks = await loadMocks();
      const m = msg.payload;
      const method = (m.method || 'GET').toUpperCase();
      const key = `${method} ${m.url}`;
      const prev = mocks[key] || {};
      mocks[key] = {
        ...prev,
        method,
        url: m.url,
        savedAt: Date.now(),
        block: {
          enabled: m.enabled !== false,
          mode: m.mode || 'abort',
          status: m.status || 0,
          repeat: m.repeat || 'always',
          remaining: repeatToRemaining(m.repeat),
        },
      };
      await commitMocks(mocks);
      sendResponse({ ok: true, key });
      return;
    }

    if (msg.type === 'REMOVE_SUBRULE') {
      const mocks = await loadMocks();
      const sub = msg.sub; // 'response' | 'throttle' | 'block'
      if (mocks[msg.key] && ['response', 'throttle', 'block'].includes(sub)) {
        delete mocks[msg.key][sub];
        pruneRule(mocks, msg.key);
        await commitMocks(mocks);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'TOGGLE_SUBRULE') {
      const mocks = await loadMocks();
      const sub = mocks[msg.key] && mocks[msg.key][msg.sub];
      if (sub) {
        sub.enabled = !!msg.enabled;
        await commitMocks(mocks);
      }
      sendResponse({ ok: true });
      return;
    }

    // Decrement a counted sub-rule after it applied. At zero, disable it.
    if (msg.type === 'CONSUME_RULE') {
      const mocks = await loadMocks();
      const { key, kind } = msg.payload || {};
      const sub = mocks[key] && mocks[key][kind];
      if (sub && sub.enabled && sub.remaining != null) {
        sub.remaining = Math.max(0, sub.remaining - 1);
        if (sub.remaining === 0) sub.enabled = false;
        await commitMocks(mocks);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'TOGGLE_MOCK') {
      const mocks = await loadMocks();
      if (mocks[msg.key]) {
        for (const sub of ['response', 'throttle', 'block']) {
          if (mocks[msg.key][sub]) mocks[msg.key][sub].enabled = !!msg.enabled;
        }
        await commitMocks(mocks);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_MOCK') {
      const mocks = await loadMocks();
      delete mocks[msg.key];
      await commitMocks(mocks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'ENABLE_ALL_MOCKS' || msg.type === 'DISABLE_ALL_MOCKS') {
      const enabled = msg.type === 'ENABLE_ALL_MOCKS';
      const mocks = await loadMocks();
      for (const k of Object.keys(mocks)) {
        for (const sub of ['response', 'throttle', 'block']) {
          if (mocks[k][sub]) mocks[k][sub].enabled = enabled;
        }
      }
      await commitMocks(mocks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_ALL_MOCKS') {
      await commitMocks({});
      sendResponse({ ok: true });
      return;
    }

    // cURL Runner — send a request from the service worker (bypasses page CORS,
    // uses the extension context, NOT the page's cookies/session). Never goes
    // through inject-main, so it always hits the real network regardless of mocks.
    if (msg.type === 'RUN_REQUEST') {
      const res = await runRequest(msg.payload || {});
      sendResponse(res);
      return;
    }
  })();
  return true;
});

// ── cURL Runner request execution ─────────────────────────────────────────────

const RUN_TIMEOUT_MS = 30_000;

async function runRequest({ method, url, headers, body }) {
  const m = (method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const start = Date.now();
  try {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new TypeError('Invalid URL — must start with http:// or https://');
    }
    const init = {
      method: m,
      headers: headers || {},
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
    };
    if (body != null && body !== '' && m !== 'GET' && m !== 'HEAD') {
      init.body = body;
    }
    const resp = await fetch(url, init);
    const text = await resp.text();
    const elapsedMs = Date.now() - start;
    const respHeaders = {};
    for (const [k, v] of resp.headers.entries()) respHeaders[k] = v;
    let size;
    try { size = new Blob([text]).size; } catch { size = text.length; }
    return {
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: text,
      elapsedMs,
      size,
      finalUrl: resp.url,
      redirected: resp.redirected,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? `Request timed out after ${RUN_TIMEOUT_MS / 1000}s`
        : (err && err.message ? err.message : 'Failed to fetch — network error or invalid URL'),
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Content script injection ─────────────────────────────────────────────────

async function ensureContentScriptsInjected(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url || !tab.url.startsWith('http')) return;

    // Check whether inject-main.js is already running in the MAIN world.
    const [mainProbe] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => !!window.__API_MOCKER_INSTALLED__,
    });
    const mainRunning = mainProbe?.result === true;

    if (!mainRunning) {
      // Tab was loaded before extension was active — inject both scripts fresh.
      // ISOLATED first so the message listener is ready before MAIN posts READY.
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        files: ['content-bridge.js'],
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['inject-main.js'],
      });
    } else {
      // inject-main is already patching fetch/XHR.
      // Send WAKE so it re-posts READY, which re-triggers the domain-check
      // handshake in content-bridge (handles stale active state after SW restart).
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: () => window.postMessage({ source: 'api-mocker-bridge', type: 'WAKE' }, '*'),
      });
    }
  } catch (err) {
    console.warn('[API Mocker] ensureContentScriptsInjected:', err);
  }
}

// ── Panel port ───────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('panel:')) return;
  const tabId = parseInt(port.name.split(':')[1], 10);
  panelPorts.set(tabId, port);

  const log = callLog.get(tabId) || [];
  port.postMessage({ type: 'INIT_LOG', payload: log, reason: 'reconnect' });
  loadMocks().then((mocks) => port.postMessage({ type: 'MOCKS_UPDATED', payload: mocks }));

  // Send domain status for this tab.
  chrome.tabs.get(tabId).then(async (tab) => {
    if (!tab || !tab.url) return;
    const domain = getDomainFromUrl(tab.url);
    if (!domain) return;
    const enabled = await isDomainEnabled(domain);
    try { port.postMessage({ type: 'DOMAIN_STATUS', domain, enabled }); } catch {}
  }).catch(() => {});

  // Ensure content scripts are running — handles tabs loaded before extension was active.
  ensureContentScriptsInjected(tabId);

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'PING') return; // keeps SW alive
    if (msg.type === 'CLEAR_LOG') {
      callLog.set(tabId, []);
      port.postMessage({ type: 'INIT_LOG', payload: [], reason: 'clear' });
    }
  });

  port.onDisconnect.addListener(() => {
    if (panelPorts.get(tabId) === port) panelPorts.delete(tabId);
  });
});

// ── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    callLog.set(details.tabId, []);
    const port = panelPorts.get(details.tabId);
    if (port) {
      try { port.postMessage({ type: 'INIT_LOG', payload: [], reason: 'navigation' }); } catch {}
    }
    refreshTabIcon(details.tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshTabIcon(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    refreshTabIcon(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  callLog.delete(tabId);
  panelPorts.delete(tabId);
});

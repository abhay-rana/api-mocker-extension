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
  return r[STORAGE_KEY] || {};
}
async function saveMocks(mocks) {
  await chrome.storage.local.set({ [STORAGE_KEY]: mocks });
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

function setTabIcon(tabId, enabled) {
  const color = enabled ? '#22c55e' : '#9ca3af';
  try {
    chrome.action.setIcon({
      tabId,
      imageData: {
        16: makeIconImageData(16, color),
        32: makeIconImageData(32, color),
      },
    });
  } catch {}
}

async function refreshTabIcon(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.startsWith('http')) { setTabIcon(tabId, false); return; }
    const domain = getDomainFromUrl(tab.url);
    const enabled = domain ? await isDomainEnabled(domain) : false;
    setTabIcon(tabId, enabled);
  } catch {}
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
      const key = `${(m.method || 'GET').toUpperCase()} ${m.url}`;
      mocks[key] = {
        method: (m.method || 'GET').toUpperCase(),
        url: m.url,
        enabled: m.enabled !== false,
        status: m.status || 200,
        body: m.body ?? '',
        savedAt: Date.now(),
      };
      await saveMocks(mocks);
      broadcastMocks(mocks);
      sendResponse({ ok: true, key });
      return;
    }

    if (msg.type === 'TOGGLE_MOCK') {
      const mocks = await loadMocks();
      if (mocks[msg.key]) {
        mocks[msg.key].enabled = !!msg.enabled;
        await saveMocks(mocks);
        broadcastMocks(mocks);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_MOCK') {
      const mocks = await loadMocks();
      delete mocks[msg.key];
      await saveMocks(mocks);
      broadcastMocks(mocks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'ENABLE_ALL_MOCKS') {
      const mocks = await loadMocks();
      for (const k of Object.keys(mocks)) mocks[k].enabled = true;
      await saveMocks(mocks);
      broadcastMocks(mocks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DISABLE_ALL_MOCKS') {
      const mocks = await loadMocks();
      for (const k of Object.keys(mocks)) mocks[k].enabled = false;
      await saveMocks(mocks);
      broadcastMocks(mocks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_ALL_MOCKS') {
      await saveMocks({});
      broadcastMocks({});
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});

// ── Panel port ───────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('panel:')) return;
  const tabId = parseInt(port.name.split(':')[1], 10);
  panelPorts.set(tabId, port);

  const log = callLog.get(tabId) || [];
  port.postMessage({ type: 'INIT_LOG', payload: log });
  loadMocks().then((mocks) => port.postMessage({ type: 'MOCKS_UPDATED', payload: mocks }));

  // Send domain status for this tab.
  chrome.tabs.get(tabId).then(async (tab) => {
    if (!tab || !tab.url) return;
    const domain = getDomainFromUrl(tab.url);
    if (!domain) return;
    const enabled = await isDomainEnabled(domain);
    try { port.postMessage({ type: 'DOMAIN_STATUS', domain, enabled }); } catch {}
  }).catch(() => {});

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'CLEAR_LOG') {
      callLog.set(tabId, []);
      port.postMessage({ type: 'INIT_LOG', payload: [] });
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
      try { port.postMessage({ type: 'INIT_LOG', payload: [] }); } catch {}
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

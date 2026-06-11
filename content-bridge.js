// Runs in ISOLATED world. Bridges page <-> service worker.
// Checks domain enable status before activating interception.
(() => {
  if (window.__API_MOCKER_BRIDGE__) return;
  window.__API_MOCKER_BRIDGE__ = true;

  const TAG_OUT = 'api-mocker-bridge';
  const TAG_IN = 'api-mocker-main';

  let currentMocks = {};
  let domainEnabled = false;

  const currentDomain = window.location.host;

  const sendMocksToPage = () => {
    window.postMessage({ source: TAG_OUT, type: 'MOCKS', payload: currentMocks }, '*');
  };

  const sendDisabledToPage = () => {
    window.postMessage({ source: TAG_OUT, type: 'DISABLED' }, '*');
  };

  const enablePage = () => {
    domainEnabled = true;
    chrome.runtime.sendMessage({ type: 'GET_MOCKS' }, (resp) => {
      if (chrome.runtime.lastError) return;
      currentMocks = (resp && resp.mocks) || {};
      sendMocksToPage();
    });
    window.dispatchEvent(new CustomEvent('api-mocker:status', { detail: { enabled: true } }));
  };

  const disablePage = () => {
    domainEnabled = false;
    currentMocks = {};
    sendDisabledToPage();
    window.dispatchEvent(new CustomEvent('api-mocker:status', { detail: { enabled: false } }));
  };

  // Page -> Bridge
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== TAG_IN) return;

    if (d.type === 'READY') {
      // Page patches are installed — check domain status before pushing mocks.
      chrome.runtime.sendMessage({ type: 'GET_DOMAIN_STATUS', domain: currentDomain }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.enabled) {
          enablePage();
        } else {
          disablePage();
        }
      });
    } else if (d.type === 'CALL') {
      if (!domainEnabled) return;
      chrome.runtime.sendMessage({ type: 'CALL', payload: d.payload }, () => {
        void chrome.runtime.lastError;
      });
      window.dispatchEvent(new CustomEvent('api-mocker:call', { detail: d.payload }));
    }
  });

  // Background -> Bridge
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'MOCKS_UPDATED') {
      if (!domainEnabled) return;
      currentMocks = msg.payload || {};
      sendMocksToPage();
      window.dispatchEvent(new CustomEvent('api-mocker:mocks', { detail: currentMocks }));
    }
    if (msg.type === 'DOMAIN_UPDATED' && msg.domain === currentDomain) {
      if (msg.enabled) {
        enablePage();
      } else {
        disablePage();
      }
    }
  });

  // Expose a small API for floating-ui.js (same isolated world).
  window.__apiMockerBridge = {
    getMocks: () => currentMocks,
    saveMock: (mock) => chrome.runtime.sendMessage({ type: 'SAVE_MOCK', payload: mock }),
    toggleMock: (key, enabled) => chrome.runtime.sendMessage({ type: 'TOGGLE_MOCK', key, enabled }),
    deleteMock: (key) => chrome.runtime.sendMessage({ type: 'DELETE_MOCK', key }),
    getDomain: () => currentDomain,
    isEnabled: () => domainEnabled,
  };
})();

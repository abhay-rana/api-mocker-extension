chrome.devtools.panels.create(
  'API Mocker',
  '',
  'panel.html',
  () => {}
);

// ── Open in IDE ────────────────────────────────────────────────────────────
const IDE_STORAGE_KEY = 'api-mocker-ide';
let ideSettings = { enabled: true, ide: 'vscode' };

chrome.storage.local.get(IDE_STORAGE_KEY, result => {
  ideSettings = result[IDE_STORAGE_KEY] || { enabled: true, ide: 'vscode' };
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[IDE_STORAGE_KEY]) {
    ideSettings = changes[IDE_STORAGE_KEY].newValue || { enabled: true, ide: 'vscode' };
  }
});

function openInVscode(vsUrl) {
  chrome.scripting.executeScript({
    target: { tabId: chrome.devtools.inspectedWindow.tabId },
    func: url => { window.open(url); },
    args: [vsUrl]
  }, () => void chrome.runtime.lastError);
}

function resolveVscodeUrl(url, lineNumber) {
  try {
    const u = new URL(url);
    let filePath;

    // Vite source map embeds absolute Windows path in the URL pathname
    // e.g. http://localhost:5173/src/auth/D:/project/src/auth/file.ts
    const embeddedWin = u.pathname.match(/\/([A-Za-z]:\/.+)/);
    if (embeddedWin) {
      filePath = '/' + embeddedWin[1];
    } else if (u.pathname.startsWith('/@fs/')) {
      // Vite /@fs/ absolute path
      filePath = u.pathname.slice(4);
    } else {
      return null;
    }

    const line = (typeof lineNumber === 'number' && isFinite(lineNumber)) ? lineNumber + 1 : 1;
    const scheme = ideSettings.ide === 'cursor' ? 'cursor' : 'vscode';
    return `${scheme}://file${filePath}:${line}`;
  } catch {
    return null;
  }
}

chrome.devtools.panels.setOpenResourceHandler((resource, lineNumber) => {
  // Always open in Sources tab
  chrome.devtools.panels.openResource(resource.url, lineNumber, () => {
    void chrome.runtime.lastError;
  });

  if (!ideSettings.enabled) return;
  const vsUrl = resolveVscodeUrl(resource.url, lineNumber);
  if (vsUrl) openInVscode(vsUrl);
});

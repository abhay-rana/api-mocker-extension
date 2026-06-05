# API Mocker Chrome Extension

Chrome MV3 extension for frontend devs to intercept, inspect, and mock fetch/XHR responses without touching the backend.

## Current State (built & working)

- Live call list — every fetch/XHR on the active tab is captured with method, status, duration
- Resizable call list column (drag handle, persisted in localStorage)
- Detail pane splits **side-by-side**: collapsible JSON tree (response body, read-only) + mock editor
- Mock editor: syntax-highlighted textarea, custom undo/redo stack (Ctrl+Z / Ctrl+Shift+Z), Format button `{ }` (Ctrl+Shift+F), `↩ Original` button resets editor to actual response body
- Save / Update / Enable / Disable / Delete per mock rule
- Mocks survive page reload (stored in `chrome.storage.local`)
- Mocks tab — lists all saved rules with toggle switches
- Floating Shadow DOM pill (bottom-right of every page) — live call counter, last 5 calls, global mock on/off toggle

## Architecture — Critical

Two content script worlds must stay separate:

- **`inject-main.js`** — `world: "MAIN"`. Patches `window.fetch` + `XMLHttpRequest`. Returns mock response if a matching enabled rule exists. Cannot touch `chrome.*` APIs.
- **`content-bridge.js`** — ISOLATED world. Bridges page ↔ background via `window.postMessage` ↔ `chrome.runtime.sendMessage`. Dispatches `api-mocker:call` / `api-mocker:mocks` custom events for `floating-ui.js`.
- **`background.js`** — service worker. Owns `chrome.storage.local` (mocks) and in-memory call log per tab (max 250). DevTools panel connects via **long-lived port** (`panel:${tabId}`), not one-shot `sendMessage`.

**Message flow:** fetch/XHR → `inject-main` posts `CALL` → `content-bridge` relays to background → background pushes to panel port + floating UI custom event.

## Files

| File | Role |
|---|---|
| `inject-main.js` | MAIN-world fetch/XHR patcher and mock interceptor |
| `content-bridge.js` | ISOLATED-world bridge; exposes `window.__apiMockerBridge` |
| `background.js` | Service worker — mock storage, call log, port management |
| `panel.html/css/js` | DevTools panel UI |
| `floating-ui.js` | In-page Shadow DOM widget |
| `devtools.html/js` | DevTools entry point — registers the panel tab |

## Key Constraints & Gotchas

- **MV3 `webRequest` is read-only** — cannot rewrite response bodies declaratively. All interception happens by monkey-patching in MAIN world.
- **`chrome.runtime.sendMessage` and `lastError`** — two valid patterns, never mix them:
  - Fire-and-forget: `sendMessage({...}, () => void chrome.runtime.lastError)` — callback consumes lastError.
  - Awaited: `try { await sendMessage({...}); } catch { void chrome.runtime.lastError; }` — Promise form, no callback. **Never `await sendMessage({...}, callback)` — passing a callback makes it return `undefined`, so `await` resolves instantly and the re-enable/post-send logic runs before the response.**
- **Panel uses a port, not sendMessage** — avoids the 5-min service worker idle timeout dropping the connection.
- **Mock mutations in background.js must go through `commitMocks(mocks)`** — it sequences `saveMocks` then `broadcastMocks`. Never call them separately or broadcast can be silently skipped.
- **Never fully re-render the detail pane on `MOCKS_UPDATED`** — it destroys the textarea and wipes the undo stack. Only reset editor value when `dataset.callId` changes (different call selected).
- **`renderMockList` is incremental** — it diffs against existing cards via a `Map` built from one `querySelectorAll` pass. Cards are patched (toggle-only) or replaced (when `dataset.savedAt` changes). Do not revert it to `innerHTML = ''` wipe-and-rebuild.
- **JSON tree has an 80 KB size guard** (`JSON_TREE_SIZE_LIMIT`) — responses above this render as a truncated `<pre>` instead of calling `buildTree`, which would freeze the panel on large payloads.
- **DevTools captures Ctrl+Z** before it reaches the textarea — native browser undo does not work. Custom undo stack is managed in `panel.js` (`undoStack[]`, `undoPtr`). Snapshots debounced at 600ms of typing. Format and ↩ Original both push snapshots before and after their bulk change so they are undoable.
- **Mocks pushed on `READY`** — when a page loads, `inject-main` posts `READY`, bridge fetches current mocks from background and pushes them to MAIN world before any requests fire.

## Install & Reload Workflow

```
chrome://extensions → Developer mode → Load unpacked → D:\api-mocker-extension
```
After any code change: click **↺ refresh** on the extension card → close and reopen DevTools.

## Planned Features (not built yet)

- Request body matching (return different mocks based on request payload)
- Status code / network delay / error simulation per rule
- Import / export all mock rules as a JSON file

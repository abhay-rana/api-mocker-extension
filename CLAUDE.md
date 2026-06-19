# API Mocker Chrome Extension

Chrome MV3 extension for frontend devs to intercept, inspect, and mock fetch/XHR responses without touching the backend.

## Current State (built & working)

- Live call list — every fetch/XHR on the active tab is captured with method, status, duration
- Resizable call list column (drag handle, persisted in localStorage)
- Detail pane splits **side-by-side**: collapsible JSON tree (response body, read-only) + mock editor
- Mock editor: syntax-highlighted textarea, custom undo/redo stack (Ctrl+Z / Ctrl+Shift+Z), Format button `{ }` (Ctrl+Shift+F), `↩ Original` button resets editor to actual response body
- Save / Update / Enable / Disable / Delete per mock rule
- **Throttle** sub-rule — fixed pre-delay before the response (presets `3G/Fast 3G/4G` or custom ms); `Offline` preset fails the request with a network error
- **Block** sub-rule — abort connection, return error status (empty body), or return empty response with a chosen code
- **Repeat counting** — Throttle/Block can apply `Always`, `×1`, or `×5`; the remaining count persists in storage, decrements per matching request (via `CONSUME_RULE`), and auto-disables the sub-rule at zero
- Mocks survive page reload (stored in `chrome.storage.local`)
- Mocks tab — lists all saved rules with per-sub-rule badges + a master toggle
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
| `curl-runner.js/css` | cURL Runner tab — standalone Postman-lite request runner (loaded by `panel.html`) |

## cURL Runner (separate subsystem)

A standalone request runner in its own panel tab (`data-tab="curl"` → `#curlView`). **Shares nothing with the mocking half** — paste a curl, edit it in a Postman-style builder, Send, view the response. See `prd/curl-runner.md` for the full spec/tests.

- **Send path** — `curl-runner.js` posts `RUN_REQUEST` to `background.js`, which `fetch()`es from the **service worker** (`runRequest()`, 30s `AbortController` timeout, `redirect: 'follow'`, `credentials: 'omit'`). This **bypasses page CORS** (via `host_permissions`) and does **not** use the page's cookies/session. It is **never** intercepted by `inject-main` (which only patches the page's `window.fetch`), so the runner always hits the real network regardless of the mock toggle.
- **Builder is source of truth** after Parse & Preview; the pinned curl is a read-only snapshot, and **Edit** re-parses a fresh paste. Auth tab writes into the headers set (`_auth`-flagged header) so headers stay the single source of truth.
- **Parser** (`parseCurl`) is "Practical" tier — handles Chrome "Copy as cURL" (`--data-raw`, `\` continuations, `$'…'`/quote styles, `-u`→Basic, `-b`, `-G`); detects `-F`/`@file` and surfaces an "unsupported" warning (panel has no filesystem).
- **`{{var}}`** resolved in URL/headers/body at Send; an undefined variable **blocks the send** with a named error. One global var set in `chrome.storage.local` (`curl-vars`). Recent requests = last 5 full requests (`curl-recent`), response not stored; clicking one **loads into the builder without auto-sending**.
- **Reuses `esc()` from `panel.js`** (global scope, loaded first). Response body uses its own `buildRespTree` whose leaves carry `data-val` for click-to-save-as-variable; "Capture token" deep-scans common token fields → `{{token}}`.
- **The disabled-domain overlay is gated to the Inspector tab only** (`updateDisabledOverlay()` in `panel.js`) — Mocks, cURL Runner, and Settings stay usable on a disabled domain. Don't revert this to the old unconditional toggle.

## Key Constraints & Gotchas

- **MV3 `webRequest` is read-only** — cannot rewrite response bodies declaratively. All interception happens by monkey-patching in MAIN world.
- **`chrome.runtime.sendMessage` and `lastError`** — two valid patterns, never mix them:
  - Fire-and-forget: `sendMessage({...}, () => void chrome.runtime.lastError)` — callback consumes lastError.
  - Awaited: `try { await sendMessage({...}); } catch { void chrome.runtime.lastError; }` — Promise form, no callback. **Never `await sendMessage({...}, callback)` — passing a callback makes it return `undefined`, so `await` resolves instantly and the re-enable/post-send logic runs before the response.**
- **Panel uses a port, not sendMessage** — avoids the 5-min service worker idle timeout dropping the connection.
- **MV3 SW dies after 30s idle even with an open port** — confirmed in production. Fix: panel sends `{ type: 'PING' }` every 25s via the port (`setInterval` in `connectPort`, cleared in `onDisconnect`). Background handles it with an early `return`. Do not remove this — without it the SW restarts, `callLog` (in-memory Map) is wiped, and the panel receives `INIT_LOG []` silently clearing all captured calls.
- **`INIT_LOG` carries a `reason` field** — `'navigation'` (page nav / SPA pushState), `'reconnect'` (SW restart), `'clear'` (user clicked Clear). Panel logs this to `diagLog[]` for debugging. `webNavigation.onCommitted` fires on every SPA route change (not just full reloads) and always sends `INIT_LOG` with an empty payload.
- **Diagnostic log** — `diagLog[]` circular buffer (max 50) in `panel.js`, written via `addDiag(msg)`. Surfaced via the `ⓘ` button in the call-list toolbar. Records SW connect/disconnect and every `INIT_LOG` with its reason and prior call count. Do not remove — it's the only way to debug panel wipes without an external service.
- **Composite rule shape** — each `METHOD URL` key stores `{ method, url, savedAt, response?, throttle?, block? }`. Each sub-rule carries its own `enabled`. Legacy flat rules (`{ status, body, enabled }`) are lazily wrapped into `{ response: {...} }` by `migrateMocks()` inside `loadMocks()` — idempotent, runs every load. Anything reading a rule must go through the sub-rule (`rule.response.status`, not `rule.status`).
- **Interception precedence (inject-main `resolveRule`)** — **Block → Throttle → Response → real network**. Block short-circuits (abort throws / synthetic status); Throttle delays then falls through (Offline preset throws); Response returns the mock; otherwise the real call runs (with the throttle delay already applied).
- **`new Response(body, {status})` throws for 204/205/304 with a non-null body** — `''` counts as non-null. Block "empty" mode offers 204, so pass `null` body for null-body statuses.
- **Repeat counting via `CONSUME_RULE`** — when a counted (`remaining != null`) Throttle/Block applies, inject-main posts `CONSUME` → bridge → background decrements `remaining` and disables the sub-rule at 0. Truly-simultaneous requests may over-apply `×1` by one — accepted limitation.
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
- Import / export all mock rules as a JSON file

# API Mocker — Release Notes

## v1.0.0 — Foundation release

**Theme:** Full DevTools panel for intercepting, inspecting, and mocking API calls — with per-domain opt-in so the extension has zero effect on sites you haven't approved.

### Core features

- **Calls tab** — live list of every fetch/XHR on the active tab with method, status code, duration, and call count badge. Updates in real time as requests fire.
- **Mocks tab** — lists all saved mock rules with count badge, toggle switches to enable/disable each rule, and delete links.
- **Detail pane** — side-by-side layout: collapsible JSON tree viewer (response body) on the left, mock editor on the right. Resizable left column via drag handle (width persisted).
- **Mock editor** — syntax-highlighted textarea with custom undo/redo stack (Ctrl+Z / Ctrl+Shift+Z). Format button `{ }` (Ctrl+Shift+F) pretty-prints JSON. `↩ Original` resets the editor to the actual response body. Save / Update / Enable / Disable / Delete per rule.
- **Mocks persist** — rules survive page reload and browser restart via `chrome.storage.local`.
- **Floating pill** — Shadow DOM widget (bottom-right) showing live call counter, last 5 calls, and a global mocks on/off toggle.

### Per-domain opt-in

- **Disabled by default** — extension does nothing on any page until you explicitly enable it for that domain.
- **Toolbar popup** — click the extension icon to toggle the current site on/off. Saved domains list shows all approved domains with a toggle and delete button per row.
- **Domain scope** — per hostname+port (`api.stripe.com`, `localhost:3000`). Subdomains are treated as separate entries. Enabling a domain covers all its routes.
- **Icon state** — green when enabled for the active tab's domain, grey otherwise.
- **Zero footprint when off** — no fetch/XHR patching, no call logging, no floating pill on disabled domains.
- **Mocks preserved on disable** — disabling pauses interception but keeps all saved rules intact.
- **DevTools panel** — shows an "Extension is off for this site" overlay with a one-click enable button when the domain is disabled.

---

## v1.1.0 — Copy as cURL ✅ done

**Theme:** One-click copy of any captured API call as a ready-to-run cURL command, at Network DevTools parity.

- **Request headers captured** — `inject-main.js` will capture headers for both fetch (`init.headers`) and XHR (`setRequestHeader` calls) and include them in every CALL payload.
- **Mocked calls included** — cURL represents the request, not the response. Copy works on mocked calls too.
- **Button placement** — always-visible 5th column on every call row, pushed to the far right with `space-between`.
- **Button appearance** — icon + label: `⧉ cURL`.
- **Copy feedback** — button flashes `✓ Copied` for 1.5s then reverts to `⧉ cURL`.
- **cURL format** — multiline with `\` continuation (matches Chrome Network DevTools copy format).
- **Header blocklist** — skip `accept-encoding`, `content-length`, `host`, `connection`, `origin`, `referer`, and all `sec-*` browser-noise headers. Keep everything else (especially `authorization`, `cookie`, `content-type`, `x-*`).

---

## v2.5.0 — Request Payload tab ✅ done

**Theme:** Surface the full request context alongside the response so you never need to open Network DevTools just to see what was sent.

### Feature

- **Response / Request tabs** — the left column (currently titled "Response Body") gains two tabs: **Response** (default, active) and **Request**. Clicking **Request** swaps the JSON tree to show the captured request payload.
- **Response tab** — identical to today: JSON tree of the response body with Expand all / Collapse all controls.
- **Request tab** — JSON tree of the request body (POST/PUT/PATCH payloads). For requests with no body (GET, DELETE, etc.) a muted `No request body` placeholder is shown instead of an empty tree.
- **Tab state is per-selection** — switching to a different call row resets the tab back to Response (same as how the editor resets today).
- **Request data already captured** — `inject-main.js` sends the request body in the CALL payload; no new capture work needed.

### UI design

```
┌─ Response Body col ──────────────────────────┐
│ [Response] [Request]   [Expand all] [Collapse]│  ← tab strip replaces the static title
├──────────────────────────────────────────────┤
│  { ... JSON tree ... }                        │
└──────────────────────────────────────────────┘
```

- Active tab is underlined / filled, inactive is muted — same visual language as the top-level Calls / Mocks tabs.
- Tabs sit on the left of the col-toolbar; Expand all / Collapse all stay on the right (hidden when Request tab is active and there is no body).

---

## v2.0.0 — Clear & Reload ✅ done

**Theme:** Network DevTools-style toolbar controls matching the Chrome Network panel UX.

- **Toolbar** — `[↺ Reload] [⊘ Clear] [🔍 Filter…]` icon buttons replace the old text Clear button.
- **Clear** — wipes all captured calls instantly. Shortcut: `Ctrl+L`.
- **Reload** — reloads the inspected page and starts fresh call tracking. Shortcut: `Ctrl+R`.
- Both shortcuts are shown in the button tooltips on hover.

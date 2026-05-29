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

### Decisions locked (implementation pending)

- **Request headers captured** — `inject-main.js` will capture headers for both fetch (`init.headers`) and XHR (`setRequestHeader` calls) and include them in every CALL payload.
- **Mocked calls included** — cURL represents the request, not the response. Copy works on mocked calls too.
- **Button placement** — always-visible 5th column on every call row, pushed to the far right with `space-between`.
- **Button appearance** — icon + label: `⧉ cURL`.
- **Copy feedback** — button flashes `✓ Copied` for 1.5s then reverts to `⧉ cURL`.
- **cURL format** — multiline with `\` continuation (matches Chrome Network DevTools copy format).
- **Header blocklist** — skip `accept-encoding`, `content-length`, `host`, `connection`, `origin`, `referer`, and all `sec-*` browser-noise headers. Keep everything else (especially `authorization`, `cookie`, `content-type`, `x-*`).

### Files to change

| File | Change |
|---|---|
| `inject-main.js` | Add `requestHeaders` field to CALL payload for fetch and XHR |
| `panel.js` | Add `buildCurl()`, `escShell()`, `HEADER_BLOCKLIST`; add cURL button to each row with copy + flash logic |
| `panel.css` | Update `.call` grid to 5 columns; add `.curl-btn` and `.curl-btn.copied` styles |

---

## v2.0.0 — Clear & Reload ✅ done

**Theme:** Network DevTools-style toolbar controls matching the Chrome Network panel UX.

- **Toolbar** — `[↺ Reload] [⊘ Clear] [🔍 Filter…]` icon buttons replace the old text Clear button.
- **Clear** — wipes all captured calls instantly. Shortcut: `Ctrl+L`.
- **Reload** — reloads the inspected page and starts fresh call tracking. Shortcut: `Ctrl+R`.
- Both shortcuts are shown in the button tooltips on hover.

# PRD — cURL Runner Tab

**Status:** Specced, ready to build
**Scope:** New "cURL Runner" tab in the API Mocker Chrome extension — a standalone Postman-lite request runner. Paste a curl, edit it in a request builder, Send, view the response. No integration with the mocking half of the extension.

---

## Design reference

`design-exports/screen1.png` (empty / paste state), `screen2.png` (builder), `screen3.png` (response). Note: the "save it as a mock" hint and bookmark icon shown in `screen3` are **intentionally dropped** (see Q4).

---

## 1. Decision Table

| # | Decision | Locked Answer |
|---|---|---|
| Q1 | Where Send executes | **Background service worker fetch** — bypasses CORS, no page session/cookies |
| Q2 | curl parser scope | **Practical** — handles Chrome "Copy as cURL" (`--data-raw`, multiline `\`, both quote styles, `-u`, `-b`); detects `-F`/`@file` → "unsupported" note |
| Q3 | Source of truth after parse | **Builder wins.** Pinned curl = read-only snapshot; "Edit" re-parses a fresh paste |
| Q4 | Save as mock | **Cut.** Pure request runner, no mock integration |
| Q5 | Recent requests | **Last 5**, full request stored in `chrome.storage.local`, no response stored; **click = load into builder (no auto-send)**; History button dropped |
| Q6 | Response panel | **Body / Headers** tabs only (Timeline cut); Body has **Pretty/Raw** toggle, JSON tree for JSON (80KB guard → `<pre>`); status + ms + size; Copy raw body; distinct red error state for failed sends |
| Q7 | Builder surface | **Full:** Method, URL, Headers (enable dots + add/delete), Params (URL-synced), Auth (None/Bearer/Basic/API Key → injects header), Body (JSON/Form-urlencoded/Raw/None), Format JSON |
| Q8 | Variables | **One global key/value set** in `chrome.storage.local`; resolve `{{var}}` in URL/headers/body at Send; undefined var **blocks send** with clear error |
| Q9 | Send behavior | 30s timeout; follow redirects; GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; header "Mocking" toggle = existing global toggle; **runner always hits real network, never own mocks** |
| F1 | Copy out (#1) | `Copy ▾` → Copy as cURL / Copy as fetch |
| F2 | Token capture (#5) | "Capture token" auto-scans common fields → `{{token}}`; + manual "Save as variable" from JSON tree leaf |
| UI | Placement | New **cURL Runner** tab in existing tab bar, styled to match; Settings/gear unchanged |

---

## 2. Architecture Notes

- **Send path:** builder state → message to `background.js` → `fetch()` in the service worker (has `host_permissions` for all origins, so CORS is bypassed). Response (status, headers, body, elapsed ms, byte size) is returned to the panel. The service-worker fetch is **never** intercepted by `inject-main.js` (which only patches the page's `window.fetch`), so the runner always reaches the real network regardless of the global mock toggle.
- **Cookies/session:** the runner uses the extension's context, **not** the active tab's cookies/session. Auth is supplied explicitly via headers / Auth tab / `{{token}}`.
- **Parser:** "Practical" tier. Accepts `-X`, `-H`, `-d`/`--data`/`--data-raw`/`--data-binary`/`--data-urlencode`, `-u user:pass` → Basic header, `-b`/`--cookie`, multiline `\` continuations, single + double quoting; parses-and-ignores `--compressed`/`-k`/`-L`. Detects `-F` multipart and `@file` body refs → shows an "unsupported flag" note (panel has no filesystem access).
- **Persistence:** `chrome.storage.local` holds (a) the global variable key/value set and (b) the last 5 recent requests (full request, no response). Both survive DevTools close/reopen and SW restart.
- **Builder is source of truth:** after Parse & Preview, the builder is authoritative; the pinned curl text is a read-only snapshot. "Edit" wipes the builder and re-parses a fresh paste.
- **Variable resolution:** `{{var}}` resolved in URL, header values, and body just before Send. Any undefined variable blocks the send with an error naming it.

---

## 3. User Journey

- **UJ1.** Dev opens DevTools → API Mocker panel → clicks the new **cURL Runner** tab. Empty state: a CURL COMMAND textarea, a `>_` "Paste a cURL above to preview and send it" prompt, and a **Recent Requests** list (last 5, or nothing on first use).
- **UJ2.** Dev pastes a curl copied from Chrome's "Copy as cURL" (multiline, `--data-raw`). Clicks **Parse & Preview**.
- **UJ3.** The view switches to the builder: pinned read-only curl at top with an **Edit** button; **method dropdown** (POST), **URL bar**, and tabs **Body / Headers / Params / Auth**. Headers tab shows parsed headers as rows with green enable dots; Body shows the parsed JSON.
- **UJ4.** Dev tweaks: toggles a header off via its dot, edits a query param in **Params** (URL bar updates live), clicks **Format JSON** to tidy the body.
- **UJ5.** Dev uses `{{token}}` in the Authorization header. (If undefined, Send is blocked with "Undefined variable: token.")
- **UJ6.** Dev clicks **Send**. Within 30s a response appears: `200 OK · 142ms · 1.2KB`, **Body** (pretty JSON tree, toggle to Raw) and **Headers** tabs, plus a **Copy** button.
- **UJ7.** Dev clicks **Capture token** → the response's `token` field is saved into `{{token}}`. The next request can now use it.
- **UJ8.** Dev clicks **Copy ▾ → Copy as fetch**, gets a `fetch()` snippet on the clipboard, pastes it into their code.
- **UJ9.** This request now appears top of **Recent Requests**. Later, the dev clicks it → the full builder reloads (no auto-send) → they hit Send again.
- **UJ10.** A request to a dead host shows a red error state: "Failed to fetch — network error or invalid URL," no Body/Headers tabs.

---

## 4. Test Cases

**T1 — Happy path (parse → send → response)**
- **Setup:** cURL Runner tab open, empty.
- **Action:** Paste `curl -X POST https://api.example.com/v1/auth/login -H 'Content-Type: application/json' -d '{"email":"a@b.com","password":"x"}'`; Parse & Preview; Send.
- **Expect:** Builder shows POST, the URL, one header, the JSON body. Send returns a status badge + ms + size, Body tab renders JSON tree.

**T2 — Chrome "Copy as cURL" paste (Practical parser)**
- **Setup:** Empty runner.
- **Action:** Paste a multiline curl using `--data-raw` and `\` line continuations and `-H` with double quotes; Parse.
- **Expect:** Parses correctly — method, all headers, and body populate. No parse error.

**T3 — Unsupported flag note**
- **Setup:** Empty runner.
- **Action:** Paste `curl -F file=@/tmp/x.png https://api.example.com/upload`; Parse.
- **Expect:** Builder populates method/URL; a visible "unsupported flag: `-F`/`@file`" note appears; no crash.

**T4 — Builder is source of truth**
- **Setup:** Parsed request in builder.
- **Action:** Change a header value, then Send.
- **Expect:** The sent request uses the edited header (not the original pinned curl text). Pinned curl text is unchanged.

**T5 — Edit re-parses fresh**
- **Setup:** Builder populated.
- **Action:** Click **Edit**, replace with a different curl, Parse & Preview.
- **Expect:** Builder is fully replaced by the new request; old values gone.

**T6 — CORS bypass**
- **Setup:** Active tab on `example.com`.
- **Action:** Send a request to a different origin (`api.other.com`) with no CORS headers.
- **Expect:** Succeeds (background fetch), response renders. No CORS error.

**T7 — Runner ignores own mocks**
- **Setup:** A saved+enabled mock exists for `GET https://api.example.com/v1/users/me`; global mocking ON.
- **Action:** Send that same GET from the cURL Runner.
- **Expect:** The **real** network response returns, not the mock body.

**T8 — Auth tab injects header**
- **Setup:** Builder with a URL.
- **Action:** Auth tab → Bearer Token → enter `abc`; check Headers tab.
- **Expect:** `Authorization: Bearer abc` present in headers; sent request includes it.

**T9 — Variable resolution**
- **Setup:** Global var `token=xyz` saved.
- **Action:** Set Authorization header to `Bearer {{token}}`; Send.
- **Expect:** Request sent with `Bearer xyz`.

**T10 — Undefined variable blocks send**
- **Setup:** No `token` var defined.
- **Action:** Use `{{token}}` in a header; Send.
- **Expect:** Send is blocked; clear error naming the undefined variable `token`. No request fired.

**T11 — Token capture (#5)**
- **Setup:** Sent a login request; response `{"token":"jwt123",...}` shown.
- **Action:** Click **Capture token**.
- **Expect:** Global var `{{token}}` = `jwt123`; usable in the next request.

**T12 — Manual save-as-variable (#5)**
- **Setup:** A response JSON tree is displayed.
- **Action:** Click a leaf value → Save as variable → name it `userId`.
- **Expect:** Global var `userId` saved with that value.

**T13 — Copy as cURL / fetch (#1)**
- **Setup:** Builder populated.
- **Action:** Copy ▾ → Copy as cURL; then Copy as fetch.
- **Expect:** Clipboard gets a valid curl string / a valid `fetch()` snippet matching the builder state; "Copied" confirmation.

**T14 — Params ⇄ URL sync**
- **Setup:** URL `https://api.example.com/items?page=1`.
- **Action:** Open Params; change `page` to `2`.
- **Expect:** URL bar updates to `?page=2`; and editing the URL bar updates Params rows.

**T15 — Recent requests (load, no auto-send)**
- **Setup:** At least one prior request sent.
- **Action:** Reopen runner; click a Recent Request row.
- **Expect:** Full builder reloads with that request; **no request is fired** until Send is pressed. List capped at 5, newest first, deduped.

**T16 — Response body Pretty/Raw + non-JSON**
- **Setup:** —
- **Action:** Send a request returning JSON, toggle Pretty/Raw; then send one returning HTML.
- **Expect:** JSON shows tree (Pretty) and literal text (Raw); HTML response renders as plain `<pre>`. Body >80KB renders as truncated `<pre>`.

**T17 — Failed send error state**
- **Setup:** —
- **Action:** Send to `https://nonexistent.invalid`.
- **Expect:** Red error state with message; no Body/Headers tabs. A real `404` instead renders normally with status + body.

**T18 — Timeout**
- **Setup:** —
- **Action:** Send to an endpoint that hangs >30s.
- **Expect:** Aborts at 30s, shows timeout error state.

**T19 — Empty / zero state**
- **Setup:** Fresh install, runner never used.
- **Action:** Open cURL Runner tab.
- **Expect:** Empty textarea, `>_` prompt, empty Recent Requests, no errors.

**T20 — Persistence across reopen**
- **Setup:** Saved vars + 5 recent requests.
- **Action:** Close and reopen DevTools.
- **Expect:** Variables and recent requests persist (from `chrome.storage.local`).

---

## 5. Backlog (deferred features)

From the brainstorm, not in v1:

- cURL ⇄ code export (axios, Python requests, Node fetch)
- Save/replay response diff (compare this response vs. previous for same request)
- "Send to Mocks" (one-click freeze a live response as a mock — bridges the two halves)
- Pre-request var chaining (pull a value from one response into the next request)
- Import Postman/Insomnia collection
- Response search / JSONPath filter
- Duplicate & tweak a recent request
- Multiple named environments (Dev/Staging/Prod) with a switcher

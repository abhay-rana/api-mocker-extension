// Runs in the page's MAIN world. Patches window.fetch and XMLHttpRequest.
// Talks to the ISOLATED-world bridge via window.postMessage.
// Only intercepts and logs when the bridge signals the domain is enabled.
(() => {
  if (window.__API_MOCKER_INSTALLED__) return;
  window.__API_MOCKER_INSTALLED__ = true;

  const TAG_OUT = 'api-mocker-main';
  const TAG_IN = 'api-mocker-bridge';

  let active = false; // set true only when bridge confirms domain is enabled
  let mocks = {};
  let callSeq = 0;

  const mockKey = (method, url) => `${(method || 'GET').toUpperCase()} ${url}`;
  const findRule = (method, url) => mocks[mockKey(method, url)] || null;

  // Resolve the three sub-rules (only when enabled) for a request.
  const resolveRule = (method, url) => {
    const rule = findRule(method, url);
    return {
      key: mockKey(method, url),
      block:    rule && rule.block    && rule.block.enabled    ? rule.block    : null,
      throttle: rule && rule.throttle && rule.throttle.enabled ? rule.throttle : null,
      response: rule && rule.response && rule.response.enabled ? rule.response : null,
    };
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));
  const consume = (key, kind) => post('CONSUME', { key, kind });

  const post = (type, payload) => {
    window.postMessage({ source: TAG_OUT, type, payload }, '*');
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== TAG_IN) return;
    if (d.type === 'MOCKS') {
      mocks = d.payload || {};
      active = true;
    }
    if (d.type === 'DISABLED') {
      active = false;
      mocks = {};
    }
    if (d.type === 'WAKE') {
      // content-bridge was injected late (already-loaded tab) — re-trigger READY
      post('READY');
    }
  });

  // Ask the bridge for current domain status / mocks.
  post('READY');

  // ---------- fetch patch ----------
  const MAX_BODY_LOG = 256 * 1024; // cap logged body at 256 KB — prevents memory bloat

  const origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    if (!active) return origFetch(input, init);

    const id = ++callSeq;
    const startedAt = performance.now();
    let url, method, reqBody;

    try {
      if (input instanceof Request) {
        url = input.url;
        method = (init && init.method) || input.method || 'GET';
        try { reqBody = await input.clone().text(); } catch { reqBody = null; }
      } else {
        url = String(input);
        method = (init && init.method) || 'GET';
        reqBody = init && init.body != null ? safeStringify(init.body) : null;
      }
    } catch {
      return origFetch(input, init);
    }

    const reqHeaders = collectFetchHeaders(input, init);
    const base = { id, url, method, requestHeaders: reqHeaders, requestBody: reqBody, timestamp: Date.now() };

    const { key, block, throttle, response } = resolveRule(method, url);

    // ── BLOCK (highest precedence) ──
    if (block) {
      consume(key, 'block');
      if (block.mode === 'abort') {
        post('CALL', { ...base, status: 0, responseBody: '[blocked — connection aborted]', mocked: false, blocked: true, durationMs: 0 });
        throw new TypeError('Failed to fetch');
      }
      const status = block.status || 200;
      post('CALL', { ...base, status, responseBody: '', mocked: false, blocked: true, durationMs: 0 });
      // 204/205/304 are null-body statuses — an empty string is still a "non-null" body and throws.
      const nullBody = status === 204 || status === 205 || status === 304;
      return new Response(nullBody ? null : '', { status, statusText: '' });
    }

    // ── THROTTLE ──
    const throttleDelayMs = throttle ? (throttle.delayMs || 0) : 0;
    if (throttle) {
      consume(key, 'throttle');
      if (throttle.preset === 'offline') {
        post('CALL', { ...base, status: 0, responseBody: '[throttle — offline]', mocked: false, throttled: true, throttleDelayMs: 0, durationMs: 0 });
        throw new TypeError('Failed to fetch');
      }
      await delay(throttle.delayMs);
    }

    // ── RESPONSE mock (delay, if any, already applied) ──
    if (response) {
      const body = response.body ?? '';
      const status = response.status || 200;
      post('CALL', { ...base, status, responseBody: body, mocked: true, throttled: !!throttle, throttleDelayMs, durationMs: Math.round(performance.now() - startedAt) });
      return new Response(body, {
        status,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── REAL network (throttle delay already applied) ──
    try {
      const res = await origFetch(input, init);
      const status = res.status;
      const elapsed = Math.round(performance.now() - startedAt);

      // Read body clone in background — never block the caller waiting for the full body
      res.clone().text().then(text => {
        const respBody = text.length > MAX_BODY_LOG
          ? text.slice(0, MAX_BODY_LOG) + '\n… [truncated — response too large to log]'
          : text;
        post('CALL', { ...base, status, responseBody: respBody, mocked: false, throttled: !!throttle, throttleDelayMs, durationMs: elapsed });
      }).catch(() => {
        post('CALL', { ...base, status, responseBody: '[unreadable]', mocked: false, throttled: !!throttle, throttleDelayMs, durationMs: elapsed });
      });

      return res; // returned immediately — app is never blocked by our logging
    } catch (err) {
      post('CALL', { ...base, status: 0, responseBody: `[network error] ${err && err.message || err}`, mocked: false, throttled: !!throttle, throttleDelayMs, durationMs: Math.round(performance.now() - startedAt) });
      throw err;
    }
  };

  // ---------- XHR patch ----------
  const X = XMLHttpRequest.prototype;
  const origOpen = X.open;
  const origSend = X.send;
  const origSetHeader = X.setRequestHeader;

  X.open = function (method, url, async, user, pass) {
    this.__am = { method, url, headers: {}, async: async !== false };
    return origOpen.call(this, method, url, async !== false, user, pass);
  };

  X.setRequestHeader = function (k, v) {
    if (this.__am) this.__am.headers[k] = v;
    return origSetHeader.call(this, k, v);
  };

  X.send = function (body) {
    if (!active) return origSend.call(this, body);

    const ctx = this.__am || {};
    const id = ++callSeq;
    const startedAt = performance.now();
    const reqBody = body != null ? safeStringify(body) : null;
    const base = { id, url: ctx.url, method: ctx.method, requestHeaders: ctx.headers || {}, requestBody: reqBody, timestamp: Date.now() };

    const { key, block, throttle, response } = resolveRule(ctx.method, ctx.url);

    // ── BLOCK ──
    if (block) {
      consume(key, 'block');
      if (block.mode === 'abort') {
        fireXhrError(this, () => post('CALL', { ...base, status: 0, responseBody: '[blocked — connection aborted]', mocked: false, blocked: true, durationMs: 0 }), 0);
        return;
      }
      const status = block.status || 200;
      fakeXhr(this, ctx, status, '', () => post('CALL', { ...base, status, responseBody: '', mocked: false, blocked: true, durationMs: 0 }), 0);
      return;
    }

    // ── THROTTLE ──
    let delayMs = 0;
    if (throttle) {
      consume(key, 'throttle');
      if (throttle.preset === 'offline') {
        fireXhrError(this, () => post('CALL', { ...base, status: 0, responseBody: '[throttle — offline]', mocked: false, throttled: true, throttleDelayMs: 0, durationMs: 0 }), 0);
        return;
      }
      delayMs = throttle.delayMs || 0;
    }
    const throttleDelayMs = delayMs;

    // ── RESPONSE mock (after delay) ──
    if (response) {
      const status = response.status || 200;
      const respBody = response.body ?? '';
      fakeXhr(this, ctx, status, respBody, () => post('CALL', { ...base, status, responseBody: respBody, mocked: true, throttled: !!throttle, throttleDelayMs, durationMs: Math.round(performance.now() - startedAt) }), delayMs);
      return;
    }

    // ── REAL network (with optional throttle delay before send) ──
    const xhr = this;
    const onDone = function () {
      let respBody = '';
      try { respBody = typeof xhr.responseText === 'string' ? xhr.responseText : String(xhr.response); } catch {}
      post('CALL', { ...base, status: xhr.status, responseBody: respBody, mocked: false, throttled: !!throttle, throttleDelayMs, durationMs: Math.round(performance.now() - startedAt) });
      xhr.removeEventListener('loadend', onDone);
    };
    this.addEventListener('loadend', onDone);
    if (delayMs > 0) {
      setTimeout(() => origSend.call(xhr, body), delayMs);
    } else {
      origSend.call(this, body);
    }
  };

  // Fake a completed XHR response (status + body) after an optional delay.
  function fakeXhr(xhr, ctx, status, respBody, postFn, delayMs) {
    Object.defineProperties(xhr, {
      readyState:   { configurable: true, get: () => 4 },
      status:       { configurable: true, get: () => status },
      statusText:   { configurable: true, get: () => (status >= 200 && status < 300 ? 'OK' : '') },
      responseText: { configurable: true, get: () => respBody },
      response:     { configurable: true, get: () => respBody },
      responseURL:  { configurable: true, get: () => ctx.url },
      responseType: { configurable: true, get: () => '' },
    });
    const fire = (name) => {
      try { xhr.dispatchEvent(new ProgressEvent(name)); } catch {}
      const handler = xhr['on' + name];
      if (typeof handler === 'function') { try { handler.call(xhr, new ProgressEvent(name)); } catch {} }
    };
    setTimeout(() => {
      try { xhr.dispatchEvent(new Event('readystatechange')); } catch {}
      if (typeof xhr.onreadystatechange === 'function') { try { xhr.onreadystatechange(new Event('readystatechange')); } catch {} }
      fire('load');
      fire('loadend');
      postFn();
    }, delayMs || 0);
  }

  // Fake a network-error XHR (status 0) after an optional delay.
  function fireXhrError(xhr, postFn, delayMs) {
    Object.defineProperties(xhr, {
      readyState:   { configurable: true, get: () => 4 },
      status:       { configurable: true, get: () => 0 },
      statusText:   { configurable: true, get: () => '' },
      responseText: { configurable: true, get: () => '' },
      response:     { configurable: true, get: () => '' },
    });
    const fire = (name) => {
      try { xhr.dispatchEvent(new ProgressEvent(name)); } catch {}
      const handler = xhr['on' + name];
      if (typeof handler === 'function') { try { handler.call(xhr, new ProgressEvent(name)); } catch {} }
    };
    setTimeout(() => {
      try { xhr.dispatchEvent(new Event('readystatechange')); } catch {}
      if (typeof xhr.onreadystatechange === 'function') { try { xhr.onreadystatechange(new Event('readystatechange')); } catch {} }
      fire('error');
      fire('loadend');
      postFn();
    }, delayMs || 0);
  }

  function collectFetchHeaders(input, init) {
    const out = {};
    const absorb = (h) => {
      if (!h) return;
      if (typeof h.forEach === 'function') {
        h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(([k, v]) => { out[k.toLowerCase()] = v; });
      } else if (typeof h === 'object') {
        Object.entries(h).forEach(([k, v]) => { out[k.toLowerCase()] = v; });
      }
    };
    try { if (input instanceof Request) absorb(input.headers); } catch {}
    try { if (init && init.headers) absorb(init.headers); } catch {}
    return out;
  }

  function safeStringify(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (v instanceof FormData) {
      const out = {};
      v.forEach((val, k) => { out[k] = typeof val === 'string' ? val : '[file]'; });
      return JSON.stringify(out);
    }
    if (v instanceof URLSearchParams) return v.toString();
    if (v instanceof Blob) return '[blob]';
    if (v instanceof ArrayBuffer) return '[arraybuffer]';
    try { return JSON.stringify(v); } catch { return String(v); }
  }
})();

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
  const findMock = (method, url) => {
    const m = mocks[mockKey(method, url)];
    return m && m.enabled ? m : null;
  };

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
  });

  // Ask the bridge for current domain status / mocks.
  post('READY');

  // ---------- fetch patch ----------
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

    const mock = findMock(method, url);
    if (mock) {
      const body = mock.body ?? '';
      const status = mock.status || 200;
      post('CALL', {
        id, url, method,
        requestHeaders: reqHeaders,
        requestBody: reqBody,
        status,
        responseBody: body,
        mocked: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
      return new Response(body, {
        status,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const res = await origFetch(input, init);
      const clone = res.clone();
      let respBody = '';
      try { respBody = await clone.text(); } catch { respBody = '[unreadable]'; }
      post('CALL', {
        id, url, method,
        requestHeaders: reqHeaders,
        requestBody: reqBody,
        status: res.status,
        responseBody: respBody,
        mocked: false,
        durationMs: Math.round(performance.now() - startedAt),
        timestamp: Date.now(),
      });
      return res;
    } catch (err) {
      post('CALL', {
        id, url, method,
        requestHeaders: reqHeaders,
        requestBody: reqBody,
        status: 0,
        responseBody: `[network error] ${err && err.message || err}`,
        mocked: false,
        durationMs: Math.round(performance.now() - startedAt),
        timestamp: Date.now(),
      });
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
    const mock = findMock(ctx.method, ctx.url);

    if (mock) {
      const status = mock.status || 200;
      const respBody = mock.body ?? '';
      const props = {
        readyState: { configurable: true, get: () => 4 },
        status: { configurable: true, get: () => status },
        statusText: { configurable: true, get: () => 'OK' },
        responseText: { configurable: true, get: () => respBody },
        response: { configurable: true, get: () => respBody },
        responseURL: { configurable: true, get: () => ctx.url },
        responseType: { configurable: true, get: () => '' },
      };
      Object.defineProperties(this, props);

      const fire = (name) => {
        try { this.dispatchEvent(new ProgressEvent(name)); } catch {}
        const handler = this['on' + name];
        if (typeof handler === 'function') {
          try { handler.call(this, new ProgressEvent(name)); } catch {}
        }
      };

      setTimeout(() => {
        try { this.dispatchEvent(new Event('readystatechange')); } catch {}
        if (typeof this.onreadystatechange === 'function') {
          try { this.onreadystatechange(new Event('readystatechange')); } catch {}
        }
        fire('load');
        fire('loadend');
        post('CALL', {
          id, url: ctx.url, method: ctx.method,
          requestHeaders: ctx.headers || {},
          requestBody: reqBody,
          status, responseBody: respBody,
          mocked: true,
          durationMs: 0,
          timestamp: Date.now(),
        });
      }, 0);
      return;
    }

    const xhr = this;
    const onDone = function () {
      let respBody = '';
      try { respBody = typeof xhr.responseText === 'string' ? xhr.responseText : String(xhr.response); } catch {}
      post('CALL', {
        id, url: ctx.url, method: ctx.method,
        requestHeaders: ctx.headers || {},
        requestBody: reqBody,
        status: xhr.status,
        responseBody: respBody,
        mocked: false,
        durationMs: Math.round(performance.now() - startedAt),
        timestamp: Date.now(),
      });
      xhr.removeEventListener('loadend', onDone);
    };
    this.addEventListener('loadend', onDone);
    return origSend.call(this, body);
  };

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

/* Élan Scents: keeps the customer / dashboard Supabase session alive.
   The sign-in response holds a short-lived access token and a refresh token, and the pages used to send the access
   token until it expired: the page still looked signed in but every request failed. This file, loaded first on every
   page that signs people in:
   - refreshes the session shortly before the access token expires (and on demand after a 401),
   - makes every request that carries the signed-in user's token use the freshest one, so no call site changes,
   - shares one refresh between tabs (Web Locks) because Supabase refresh tokens are single-use,
   - tells the page when the session is really over ("elan-auth-expired") and when tokens changed ("elan-auth-refreshed"),
   - signs out on the server too (revokes the refresh token) instead of only forgetting it locally. */
(function () {
  'use strict';
  if (window.ElanAuth || typeof window.fetch !== 'function') return;

  var KEY = 'elan_auth_session';
  var MARGIN_MS = 60 * 1000;           // refresh when less than this is left
  var FORCE_EVERY_MS = 60 * 1000;      // at most one refresh forced by a 401 per minute
  var realFetch = window.fetch.bind(window);
  var configPromise = null;
  var inflight = null;
  var lastForced = 0;

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function write(session) { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (_) {} }
  function clear() { try { localStorage.removeItem(KEY); } catch (_) {} }
  function fire(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (_) {} }

  function payload(token) {
    try {
      var part = String(token).split('.')[1];
      if (!part) return null;
      part = part.replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch (_) { return null; }
  }
  function expiresAt(session) {
    var claims = session && session.access_token && payload(session.access_token);
    if (claims && claims.exp) return claims.exp * 1000;
    return session && session.expires_at ? Number(session.expires_at) * 1000 : 0;
  }
  function needsRefresh(session, margin) {
    var at = expiresAt(session);
    return !!(session && session.refresh_token && at && at - Date.now() < (margin === undefined ? MARGIN_MS : margin));
  }
  function isUserToken(token) { var claims = payload(token); return !!claims && claims.role === 'authenticated'; }

  function config() {
    if (!configPromise) configPromise = realFetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.url || !c.key) throw new Error('no_config');
      return c;
    }).catch(function (error) { configPromise = null; throw error; });
    return configPromise;
  }

  function withLock(task) {
    try { if (navigator.locks && typeof navigator.locks.request === 'function') return navigator.locks.request('elan-auth-refresh', task); } catch (_) {}
    return Promise.resolve().then(task);
  }

  /* Resolves with the session to use now (refreshed if needed), or null when the session is over. */
  function refresh(force) {
    if (inflight) return inflight;
    var start = read();
    if (!start || !start.refresh_token) return Promise.resolve(start);
    inflight = withLock(function () {
      var current = read();                                   // another tab may have refreshed while we waited for the lock
      if (!current || !current.refresh_token) return current;
      if (force ? current.access_token !== start.access_token : !needsRefresh(current)) return current;
      return config().then(function (c) {
        return realFetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refresh_token })
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            if (response.ok && body.access_token) {
              var next = Object.assign({}, current, body);
              write(next);
              fire('elan-auth-refreshed', next);
              return next;
            }
            var other = read();                              // lost a race with another tab that already rotated the token
            if (other && other.refresh_token && other.refresh_token !== current.refresh_token) return other;
            if (response.status === 400 || response.status === 401 || response.status === 403) { clear(); fire('elan-auth-expired'); return null; }
            return current;                                  // Supabase is struggling: keep the session and try again later
          });
        });
      }).catch(function () { return current; });             // offline: keep the session
    }).then(function (session) { inflight = null; return session; }, function () { inflight = null; return read(); });
    return inflight;
  }

  function headerValue(init) {
    var h = init && init.headers;
    if (!h) return '';
    if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get('Authorization') || '';
    if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) if (String(h[i][0]).toLowerCase() === 'authorization') return String(h[i][1]); return ''; }
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === 'authorization') return String(h[k]);
    return '';
  }
  function withAuthorization(init, value) {
    var out = Object.assign({}, init), h = init.headers;
    if (typeof Headers !== 'undefined' && h instanceof Headers) { var copy = new Headers(h); copy.set('Authorization', value); out.headers = copy; }
    else if (Array.isArray(h)) out.headers = h.map(function (pair) { return String(pair[0]).toLowerCase() === 'authorization' ? [pair[0], value] : pair; });
    else { var plain = {}; for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) plain[k] = k.toLowerCase() === 'authorization' ? value : h[k]; out.headers = plain; }
    return out;
  }

  /* Any request that carries a signed-in user's access token goes out with the freshest one, and is retried once with a
     refreshed token if the server still answers 401. Requests with the anonymous key or without a token are untouched. */
  window.fetch = function (input, init) {
    if (!init || typeof input !== 'string' || init.keepalive) return realFetch(input, init);
    var match = /^Bearer\s+(.+)$/i.exec(headerValue(init));
    if (!match || !isUserToken(match[1])) return realFetch(input, init);
    var sent = match[1];
    var session = read();
    var ready = session && session.access_token && needsRefresh(session) ? refresh(false) : Promise.resolve(session);
    return ready.then(function (current) {
      var token = current && current.access_token && isUserToken(current.access_token) ? current.access_token : sent;
      var first = token === sent ? init : withAuthorization(init, 'Bearer ' + token);
      return realFetch(input, first).then(function (response) {
        if (response.status !== 401 || Date.now() - lastForced < FORCE_EVERY_MS) return response;
        lastForced = Date.now();
        return refresh(true).then(function (next) {
          if (!next || !next.access_token || next.access_token === token) return response;
          return realFetch(input, withAuthorization(init, 'Bearer ' + next.access_token));
        });
      });
    });
  };

  /* Signs out here and on the server (revokes this session's refresh token). Never rejects. */
  function signOut() {
    var session = read();
    clear();
    if (!session || !session.access_token) return Promise.resolve();
    return config().then(function (c) {
      return Promise.race([
        realFetch(c.url + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: c.key, Authorization: 'Bearer ' + session.access_token } }),
        new Promise(function (resolve) { setTimeout(resolve, 1500); })
      ]);
    }).catch(function () {});
  }

  function tick() { var s = read(); if (s && needsRefresh(s)) refresh(false); }
  setInterval(tick, 30 * 1000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('online', tick);
  tick();

  window.ElanAuth = { session: read, refresh: function () { return refresh(false); }, signOut: signOut, needsRefresh: needsRefresh, expiresAt: expiresAt };
})();

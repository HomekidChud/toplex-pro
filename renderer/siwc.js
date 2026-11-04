/* Toplix Pro — Sign in with ChatGPT (OpenAI's open-source / local-app flow).
 * OIDC authorization-code + PKCE in the system browser, loopback callback,
 * ID-token validation, encrypted credential storage and token refresh.
 * Docs: https://developers.openai.com/siwc/token-sharing-open-source
 */
(function () {
  'use strict';
  var N = window.ToplixNative;
  var ISSUER = 'https://auth.openai.com';
  var AUTHORIZE = ISSUER + '/api/accounts/authorize';
  var TOKEN = ISSUER + '/api/accounts/oauth/token';
  var RESOURCE = 'https://api.openai.com/v1';
  var SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  var PLAN_SCOPE = 'chatgpt.tokens.use.direct';
  var APP_NAME = 'Toplix Pro';
  var REC_KEY = 'siwc.account';

  var session = null;       // { client_id, email, sub, id_token, access_token, refresh_token, expires_at, scopes }
  var refreshing = null;
  var listeners = [];

  function emit() { listeners.forEach(function (fn) { try { fn(session); } catch (e) { /* ignore */ } }); }

  /* ---------- helpers ---------- */
  function b64url(bytes) {
    var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '=';
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function sha256(str) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (b) { return new Uint8Array(b); }); }
  function jwtParts(t) {
    var p = String(t).split('.');
    if (p.length !== 3) throw new Error('Malformed ID token');
    return { header: JSON.parse(new TextDecoder().decode(fromB64url(p[0]))), payload: JSON.parse(new TextDecoder().decode(fromB64url(p[1]))), signed: p[0] + '.' + p[1], sig: fromB64url(p[2]) };
  }

  function hostId() {
    var id = window.ToplixStore.get('toplex.siwc.host');
    if (!id) { id = 'urn:uuid:' + uuid(); window.ToplixStore.set('toplex.siwc.host', id); }
    return id;
  }

  function request(method, url, formParams) {
    var opts = { method: method, url: url, headers: { Accept: 'application/json' } };
    if (formParams) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(formParams).toString();
    }
    return N.http(opts).then(function (res) {
      var json = null; try { json = JSON.parse(res.text); } catch (e) { /* not json */ }
      if (res.status >= 400) {
        var err = new Error((json && (json.error_description || json.error)) || ('HTTP ' + res.status));
        err.code = json && json.error; err.status = res.status;
        throw err;
      }
      return json || {};
    });
  }

  /* ---------- storage ---------- */
  function save() {
    if (!session) return N.secureRemove(REC_KEY);
    return N.secureSet(REC_KEY, JSON.stringify(session));
  }

  /* ---------- ID token validation ---------- */
  var jwksCache = null;
  function getJwks() {
    if (jwksCache) return Promise.resolve(jwksCache);
    return request('GET', ISSUER + '/.well-known/openid-configuration').then(function (cfg) {
      if (!cfg.jwks_uri || cfg.jwks_uri.indexOf(ISSUER + '/') !== 0) throw new Error('Unexpected JWKS location');
      return request('GET', cfg.jwks_uri).then(function (jwks) { jwksCache = jwks; return jwks; });
    });
  }

  function validateIdToken(idToken, clientId, nonce) {
    var t = jwtParts(idToken);
    if (t.header.alg !== 'RS256') return Promise.reject(new Error('Unsupported ID token algorithm'));
    return getJwks().then(function (jwks) {
      var jwk = (jwks.keys || []).filter(function (k) { return k.kid === t.header.kid; })[0];
      if (!jwk) { jwksCache = null; throw new Error('Signing key not found'); }
      return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    }).then(function (key) {
      return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, t.sig, new TextEncoder().encode(t.signed));
    }).then(function (ok) {
      if (!ok) throw new Error('ID token signature is invalid');
      var c = t.payload, aud = [].concat(c.aud || []);
      if (c.iss !== ISSUER) throw new Error('ID token issuer mismatch');
      if (aud.indexOf(clientId) === -1) throw new Error('ID token audience mismatch');
      if (!c.exp || c.exp * 1000 < Date.now() - 60000) throw new Error('ID token expired');
      if (nonce && c.nonce !== nonce) throw new Error('ID token nonce mismatch');
      return c;
    });
  }

  /* ---------- sign in ---------- */
  function signIn() {
    if (!N || !N.available) return Promise.reject(new Error('Sign in with ChatGPT needs the Toplix Pro app (desktop or Android).'));
    var verifier = rand(48), state = rand(24), nonce = rand(24), redirect, saved = session;

    return (saved ? Promise.resolve(saved) : N.secureGet(REC_KEY).then(function (raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }))
      .then(function (rec) { saved = rec; return N.loopbackStart(1455); })
      .then(function (r) {
        redirect = 'http://127.0.0.1:' + r.port + '/auth/callback';
        return sha256(verifier);
      })
      .then(function (digest) {
        var q = {
          client_id: saved && saved.client_id ? saved.client_id : 'dynamic_agent_client',
          ext_agent_host_id: hostId(),
          response_type: 'code',
          redirect_uri: redirect,
          scope: SCOPES,
          resource: RESOURCE,
          state: state,
          nonce: nonce,
          code_challenge_method: 'S256',
          code_challenge: b64url(digest)
        };
        if (!(saved && saved.client_id)) q.agent_name_hint = APP_NAME;
        else {
          if (saved.id_token) q.id_token_hint = saved.id_token;
          if (saved.email) q.login_hint = saved.email;
        }
        var url = AUTHORIZE + '?' + new URLSearchParams(q).toString();
        return N.openExternal(url).then(function () { return N.loopbackWait(); });
      })
      .then(function (cbUrl) {
        N.loopbackStop();
        var u = new URL(cbUrl), p = u.searchParams;
        if (p.get('state') !== state) throw new Error('Sign-in response did not match this request');
        if (p.get('error')) {
          throw new Error(p.get('error') === 'access_denied' ? 'Sign-in was cancelled' : (p.get('error_description') || p.get('error')));
        }
        var clientId = (saved && saved.client_id) || p.get('client_id');
        if (!clientId || clientId === 'dynamic_agent_client') throw new Error('Registration did not return a client ID');
        if (saved && saved.client_id && p.get('client_id') && p.get('client_id') !== saved.client_id) throw new Error('Unexpected client ID in sign-in response');
        if (!p.get('code')) throw new Error('Sign-in response had no code');
        return request('POST', TOKEN, {
          grant_type: 'authorization_code', client_id: clientId, code: p.get('code'),
          code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE
        }).then(function (tok) {
          if (!tok.id_token) throw new Error('No ID token returned');
          return validateIdToken(tok.id_token, clientId, nonce).then(function (claims) {
            if (saved && saved.sub && saved.sub !== claims.sub) throw new Error('Signed in to a different ChatGPT account than the one saved');
            var scopes = String(tok.scope || p.get('scope') || '').split(/[\s+]+/).filter(Boolean);
            return {
              client_id: clientId, email: claims.email || (saved && saved.email) || '', name: claims.name || '', sub: claims.sub,
              id_token: tok.id_token, access_token: tok.access_token, refresh_token: tok.refresh_token || (saved && saved.refresh_token) || '',
              expires_at: Date.now() + (tok.expires_in || 3600) * 1000, scopes: scopes, saved_at: new Date().toISOString()
            };
          });
        });
      })
      .then(function (rec) {
        if (rec.scopes.indexOf(PLAN_SCOPE) === -1) {
          // Signed in, but the user did not allow ChatGPT plan usage: keep the identity only.
          session = Object.assign({}, rec, { access_token: '', refresh_token: '' });
          return save().then(function () { emit(); throw planError(); });
        }
        session = rec;
        return save().then(function () { emit(); return session; });
      })
      .catch(function (e) { try { N.loopbackStop(); } catch (x) { /* ignore */ } throw e; });
  }

  function planError() {
    var e = new Error('ChatGPT plan usage was not allowed. Approve it when signing in, or use an API key instead.');
    e.code = 'plan_not_granted';
    return e;
  }

  /* ---------- refresh ---------- */
  function refresh() {
    if (refreshing) return refreshing;
    if (!session || !session.refresh_token) return Promise.reject(new Error('Not signed in'));
    var s = session;
    refreshing = request('POST', TOKEN, {
      grant_type: 'refresh_token', client_id: s.client_id, refresh_token: s.refresh_token, resource: RESOURCE
    }).then(function (tok) {
      session = Object.assign({}, s, {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || s.refresh_token,
        id_token: tok.id_token || s.id_token,
        expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
        scopes: tok.scope ? String(tok.scope).split(/[\s+]+/).filter(Boolean) : s.scopes
      });
      return save().then(function () { emit(); return session; });
    }).catch(function (e) {
      if (e.code === 'invalid_grant') { session = Object.assign({}, s, { access_token: '', refresh_token: '' }); save(); emit(); }
      throw e;
    }).then(function (r) { refreshing = null; return r; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }

  function accessToken() {
    if (!session || !session.access_token) return Promise.reject(new Error('Sign in with ChatGPT again to continue'));
    if (session.expires_at - 60000 > Date.now()) return Promise.resolve(session.access_token);
    return refresh().then(function (s) { return s.access_token; });
  }

  function restore() {
    if (!N || !N.available) return Promise.resolve(null);
    return Promise.resolve(N.secureGet(REC_KEY)).then(function (raw) {
      try { session = raw ? JSON.parse(raw) : null; } catch (e) { session = null; }
      if (session && session.access_token && session.expires_at - 60000 <= Date.now()) {
        return refresh().catch(function () { /* offline: keep the session, retry on next request */ }).then(function () { return session; });
      }
      return session;
    }).catch(function () { return null; });
  }

  function signOut() {
    var s = session;
    var done = function () {
      // Keep the registration (client id, email, sub) so a later sign-in reuses it.
      session = s ? { client_id: s.client_id, email: s.email, name: s.name, sub: s.sub, id_token: s.id_token, access_token: '', refresh_token: '', expires_at: 0, scopes: [] } : null;
      return save().then(function () { emit(); });
    };
    if (!s || !s.refresh_token) return done();
    return request('GET', ISSUER + '/.well-known/openid-configuration')
      .then(function (cfg) {
        if (!cfg.revocation_endpoint || cfg.revocation_endpoint.indexOf(ISSUER + '/') !== 0) return null;
        return request('POST', cfg.revocation_endpoint, { token: s.refresh_token, token_type_hint: 'refresh_token', client_id: s.client_id });
      })
      .catch(function () { /* revocation unconfirmed: still sign out locally */ })
      .then(done);
  }

  function listModels() {
    return accessToken().then(function (tok) {
      return N.http({ method: 'GET', url: RESOURCE + '/models', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
    }).then(function (res) {
      if (res.status >= 400) throw new Error('HTTP ' + res.status);
      var j = JSON.parse(res.text);
      return (j.models || []).filter(function (m) { return m.visibility === 'list'; }).map(function (m) { return { slug: m.slug, name: m.display_name || m.slug }; });
    });
  }

  window.ToplixSIWC = {
    signIn: signIn, signOut: signOut, restore: restore, accessToken: accessToken, listModels: listModels,
    onChange: function (fn) { listeners.push(fn); },
    get active() { return !!(session && session.access_token); },
    get account() { return session ? { email: session.email, name: session.name } : null; },
    get supported() { return !!(N && N.available); }
  };
})();

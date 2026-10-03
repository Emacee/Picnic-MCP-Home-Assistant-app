// Minimal OAuth 2.1 authorization server for this single-user MCP gateway.
//
// Why this exists: MCP clients that only offer an "OAuth" connector option
// (no raw header field — Claude on the web, iOS and Android) speak the MCP
// Authorization spec: OAuth 2.1 + Dynamic Client Registration (RFC 7591) +
// PKCE (RFC 7636), discovered through RFC 9728 / RFC 8414 metadata. There is
// no separate identity provider, so the add-on's own mcp_auth_token doubles
// as the login credential on the /authorize consent page: whoever knows that
// token can approve a new client, which then gets its own opaque
// access/refresh tokens instead of the shared secret itself.
//
// By default the add-on is served at the root of its own hostname, and then
// this is an ordinary root-mounted server. It can also live under a prefix
// (e.g. /picnic) to share one public hostname with other MCP servers. Its
// issuer is then https://host/picnic, and RFC 8414 / RFC 9728 put the
// metadata for such an issuer at
// /.well-known/<kind>/picnic — a path at the ROOT of the host, not under the
// prefix. Both forms are served here, plus the OIDC-style
// /picnic/.well-known/... that some clients try as a fallback, and the
// gateway claims all of them when it decides what to forward elsewhere.
//
// Deliberately simple: opaque random tokens looked up server-side (no JWT),
// one fixed scope, public clients + PKCE only, rotating refresh tokens, and a
// flat JSON file for persistence. Proportionate to a one-person deployment.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import express from "express";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, sliding (rotated on use)
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CLIENTS = 200;

// Brute-force throttle on the consent form. The token is 256-bit random by
// default, so this is defence in depth, not the primary defence.
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifyPkce(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== "string" || !codeVerifier) return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return timingSafeEqualStr(computed, codeChallenge);
}

function redirectHost(uri) {
  try {
    const url = new URL(uri);
    return url.host || url.protocol;
  } catch {
    return uri;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.storePath      JSON file for clients and tokens (under /data)
 * @param {string} opts.basePath       e.g. "/picnic", or "" for the host root
 * @param {string} opts.publicOrigin   origin from mcp_url, or "" to use the request's host
 * @param {() => string} opts.getAuthToken
 * @param {(level: string, msg: string, extra?: object) => void} opts.log
 */
export function createOAuth({ storePath, basePath, publicOrigin, getAuthToken, log }) {
  const empty = () => ({ clients: {}, accessTokens: {}, refreshTokens: {} });
  let store;
  try {
    store = { ...empty(), ...JSON.parse(fs.readFileSync(storePath, "utf8")) };
  } catch {
    store = empty();
  }

  function save() {
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  }

  function prune() {
    const now = Date.now();
    for (const [t, rec] of Object.entries(store.accessTokens)) {
      if (rec.expires_at < now) delete store.accessTokens[t];
    }
    for (const [t, rec] of Object.entries(store.refreshTokens)) {
      if (rec.expires_at && rec.expires_at < now) delete store.refreshTokens[t];
    }
  }

  function issueTokens(clientId) {
    prune();
    const now = Date.now();
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    store.accessTokens[accessToken] = { client_id: clientId, issued_at: now, expires_at: now + ACCESS_TOKEN_TTL_MS };
    store.refreshTokens[refreshToken] = { client_id: clientId, issued_at: now, expires_at: now + REFRESH_TOKEN_TTL_MS };
    save();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: "mcp",
    };
  }

  // Authorization codes are one-time and short-lived; memory is enough.
  const pendingCodes = new Map();
  const attempts = new Map();

  function tooManyAttempts(key) {
    const rec = attempts.get(key);
    if (!rec) return false;
    if (Date.now() - rec.windowStart > ATTEMPT_WINDOW_MS) {
      attempts.delete(key);
      return false;
    }
    return rec.count >= MAX_ATTEMPTS;
  }
  function recordAttempt(key) {
    const rec = attempts.get(key);
    if (!rec || Date.now() - rec.windowStart > ATTEMPT_WINDOW_MS) {
      attempts.set(key, { count: 1, windowStart: Date.now() });
    } else {
      rec.count += 1;
    }
  }

  // With "trust proxy" on, the request's host can come from X-Forwarded-Host,
  // which the caller controls. Prefer the operator's configured origin so the
  // discovery documents can't be made to advertise someone else's hostname.
  const origin = (req) => publicOrigin || `${req.protocol}://${req.get("host")}`;
  const issuer = (req) => `${origin(req)}${basePath}`;

  function protectedResourceMetadata(req, res) {
    res.json({
      resource: `${issuer(req)}/mcp`,
      authorization_servers: [issuer(req)],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  }

  function authorizationServerMetadata(req, res) {
    const base = issuer(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  function consentPage({ clientName, redirectUri, error, hiddenFields }) {
    const hidden = Object.entries(hiddenFields)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v ?? "")}">`)
      .join("\n    ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — Picnic MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 440px; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; font-family: ui-monospace, monospace; padding: .6rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; margin: .5rem 0 1rem; }
  button { width: 100%; padding: .6rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; font-size: 1rem; }
  .error { color: #c0392b; font-size: .9rem; }
  p.small { font-size: .85rem; opacity: .8; }
  code { word-break: break-all; }
</style>
</head>
<body>
  <h1>Authorize ${escapeHtml(clientName || "MCP client")}</h1>
  <p>This client wants to use your <strong>Picnic account</strong> through your
  Home Assistant: search products, read your cart and deliveries and — depending
  on the add-on's settings — change them.</p>
  <p class="small">After approval you are sent back to <code>${escapeHtml(redirectHost(redirectUri))}</code>.
  Only continue if that is the app you are connecting.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="${escapeHtml(`${basePath}/authorize`)}">
    ${hidden}
    <label for="token">Bearer token</label>
    <input type="password" id="token" name="token" autocomplete="off" autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <p class="small">The token is the <code>mcp_auth_token</code> in this add-on's
  Configuration tab in Home Assistant.</p>
</body>
</html>`;
  }

  const router = express.Router();
  const ownPaths = [
    `/.well-known/oauth-protected-resource${basePath}/mcp`,
    `/.well-known/oauth-protected-resource${basePath}`,
    `${basePath}/.well-known/oauth-protected-resource`,
    `${basePath}/.well-known/oauth-protected-resource/mcp`,
    `/.well-known/oauth-authorization-server${basePath}`,
    `/.well-known/openid-configuration${basePath}`,
    `${basePath}/.well-known/oauth-authorization-server`,
    `${basePath}/.well-known/openid-configuration`,
    `${basePath}/register`,
    `${basePath}/authorize`,
    `${basePath}/token`,
  ];

  router.use((req, res, next) => {
    if (!ownPaths.includes(req.path)) return next();
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  for (const p of ownPaths.slice(0, 4)) router.get(p, protectedResourceMetadata);
  for (const p of ownPaths.slice(4, 8)) router.get(p, authorizationServerMetadata);

  // --- RFC 7591: Dynamic Client Registration ---
  router.post(`${basePath}/register`, express.json({ limit: "64kb" }), (req, res) => {
    const body = req.body ?? {};
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u) => typeof u === "string" && /^[a-z][a-z0-9+.-]*:/i.test(u))
      : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
      return;
    }

    const ids = Object.keys(store.clients);
    if (ids.length >= MAX_CLIENTS) {
      const oldest = ids.sort((a, b) => store.clients[a].created_at - store.clients[b].created_at)[0];
      delete store.clients[oldest];
    }

    const clientId = randomBytes(16).toString("hex");
    const record = {
      client_id: clientId,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
      redirect_uris: redirectUris.slice(0, 10),
      created_at: Date.now(),
    };
    store.clients[clientId] = record;
    save();
    log("info", "Registered a new OAuth client", { clientName: record.client_name });

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(record.created_at / 1000),
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // --- /authorize: consent form gated by the add-on's bearer token ---
  router.get(`${basePath}/authorize`, (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } = req.query;
    const client = typeof client_id === "string" ? store.clients[client_id] : undefined;
    if (!client) {
      res.status(400).type("text/plain").send("Unknown client_id. Remove the connector in your MCP client and add it again.");
      return;
    }
    if (typeof redirect_uri !== "string" || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).type("text/plain").send("redirect_uri does not match what this client registered.");
      return;
    }

    const redirectWithError = (error) => {
      const url = new URL(redirect_uri);
      url.searchParams.set("error", error);
      if (typeof state === "string") url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    };
    if (response_type !== "code") return redirectWithError("unsupported_response_type");
    if (code_challenge_method !== "S256" || typeof code_challenge !== "string" || !code_challenge) {
      return redirectWithError("invalid_request");
    }

    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    res.type("html").send(consentPage({
      clientName: client.client_name,
      redirectUri: redirect_uri,
      hiddenFields: { client_id, redirect_uri, state: typeof state === "string" ? state : "", code_challenge },
    }));
  });

  router.post(`${basePath}/authorize`, express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    // Keyed on the raw socket address, never req.ip: "trust proxy" makes
    // req.ip the caller-controlled X-Forwarded-For. Behind a tunnel every
    // request shares one address, so this throttles consent globally —
    // the safe direction for a rare, interactive action.
    const key = req.socket.remoteAddress ?? "unknown";
    const { client_id, redirect_uri, state, code_challenge, token } = req.body ?? {};
    const client = typeof client_id === "string" ? store.clients[client_id] : undefined;
    if (!client || typeof redirect_uri !== "string" || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).type("text/plain").send("Invalid client or redirect_uri.");
      return;
    }
    if (typeof code_challenge !== "string" || !code_challenge) {
      res.status(400).type("text/plain").send("Missing PKCE code_challenge.");
      return;
    }

    const again = (status, error) => res.status(status).type("html").send(consentPage({
      clientName: client.client_name,
      redirectUri: redirect_uri,
      error,
      hiddenFields: { client_id, redirect_uri, state: state ?? "", code_challenge },
    }));

    if (tooManyAttempts(key)) return again(429, "Too many attempts. Try again in 15 minutes.");

    const expected = getAuthToken();
    const ok = typeof token === "string" && token.length > 0 && expected.length > 0 && timingSafeEqualStr(token.trim(), expected);
    if (!ok) {
      recordAttempt(key);
      log("warning", "Rejected OAuth consent: wrong bearer token", { clientName: client.client_name });
      return again(401, "That token is not correct.");
    }

    const code = randomBytes(32).toString("hex");
    pendingCodes.set(code, { client_id, redirect_uri, code_challenge, expires_at: Date.now() + AUTH_CODE_TTL_MS });
    setTimeout(() => pendingCodes.delete(code), AUTH_CODE_TTL_MS + 1000).unref();
    log("info", "Approved an OAuth client", { clientName: client.client_name });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (typeof state === "string" && state) url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  // --- /token: authorization_code and refresh_token grants ---
  router.post(
    `${basePath}/token`,
    express.urlencoded({ extended: false, limit: "16kb" }),
    express.json({ limit: "16kb" }),
    (req, res) => {
      res.set("Cache-Control", "no-store");
      const body = req.body ?? {};

      if (body.grant_type === "authorization_code") {
        const { code, redirect_uri, client_id, code_verifier } = body;
        const pending = typeof code === "string" ? pendingCodes.get(code) : undefined;
        if (!pending || pending.expires_at < Date.now() || pending.client_id !== client_id || pending.redirect_uri !== redirect_uri) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        // One-time use, even when PKCE fails: a code is never worth a second try.
        pendingCodes.delete(code);
        if (!verifyPkce(code_verifier, pending.code_challenge)) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        res.json(issueTokens(client_id));
        return;
      }

      if (body.grant_type === "refresh_token") {
        const { refresh_token, client_id } = body;
        const rec = typeof refresh_token === "string" ? store.refreshTokens[refresh_token] : undefined;
        if (!rec || (rec.expires_at && rec.expires_at < Date.now()) || (client_id && rec.client_id !== client_id) || !store.clients[rec.client_id]) {
          res.status(400).json({ error: "invalid_grant" });
          return;
        }
        // Rotate: the presented refresh token is spent, a new pair is issued.
        delete store.refreshTokens[refresh_token];
        res.json(issueTokens(rec.client_id));
        return;
      }

      res.status(400).json({ error: "unsupported_grant_type" });
    },
  );

  return {
    router,
    ownPaths,
    /** RFC 9728 document URL for the WWW-Authenticate header on a 401. */
    resourceMetadataUrl: (req) => `${origin(req)}/.well-known/oauth-protected-resource${basePath}/mcp`,
    isValidAccessToken(token) {
      const rec = store.accessTokens[token];
      if (!rec) return false;
      if (rec.expires_at < Date.now()) {
        delete store.accessTokens[token];
        save();
        return false;
      }
      return true;
    },
    listClients() {
      return Object.values(store.clients)
        .map((c) => ({ client_name: c.client_name, created_at: c.created_at, redirect_host: redirectHost(c.redirect_uris[0]) }))
        .sort((a, b) => b.created_at - a.created_at);
    },
    /** Every issued token becomes invalid; clients stay registered. */
    revokeAll() {
      store.accessTokens = {};
      store.refreshTokens = {};
      save();
    },
  };
}

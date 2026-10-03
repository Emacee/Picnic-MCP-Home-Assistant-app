// Home Assistant gateway around ivo-toby/mcp-picnic.
//
// This file is bundled together with upstream's TypeScript sources at image
// build time (see the Dockerfile): it imports upstream's tool registry, MCP
// request handlers and Picnic client directly instead of running upstream's
// own HTTP server. That server is fine next to a trusted client, but behind a
// public tunnel three of its choices get in the way:
//
//   * its rate limiter allows 100 requests per 15 minutes per client IP, and
//     behind a tunnel or the forwarding below every request has the same IP,
//     so a single meal-planning conversation could lock everybody out;
//   * a failed Picnic login at startup ends the process, which under
//     Supervisor becomes a crash loop that retries a wrong password forever;
//   * every tool is always published, including ones that cancel deliveries
//     or read payment details.
//
// What this gateway adds on top of upstream's tools:
//
//   1. Bearer-token auth, plus a small OAuth 2.1 server (oauth.mjs) for
//      clients without a header field (Claude web and mobile).
//   2. Served at the root of its own hostname by default
//      (https://picnic.example.com/mcp). Optionally under a path prefix with
//      everything else forwarded to another service (forward.mjs), so one
//      public hostname can carry several MCP add-ons.
//   3. Tool groups the operator switches on explicitly; tools this add-on
//      doesn't know (added by a future upstream pin) are withheld until
//      someone reviews them.
//   4. A login state machine with 2FA and re-login from the ingress
//      dashboard, and tools that refuse politely instead of re-trying a
//      broken login on every call.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { toolRegistry } from "../src/tools/index.ts";
import { BaseTransportServer } from "../src/transports/base.ts";
import {
  getPicnicClient,
  initializePicnicClient,
  resetPicnicClient,
  saveSession,
  verifyPicnic2FACode,
} from "../src/utils/picnic-client.ts";
import { installFetchProxy } from "../src/utils/proxy.ts";

import { createOAuth, timingSafeEqualStr } from "./oauth.mjs";
import { createForwarder, parseForwardTarget, probeForwardTarget } from "./forward.mjs";

/* ------------------------------------------------------------------ */
/* Configuration (exported by run.sh from the add-on options)          */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.MCP_PORT ?? 8097);
const INGRESS_PORT = Number(process.env.INGRESS_PORT ?? 8096);
const AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN ?? "").trim();
const MCP_URL = (process.env.MCP_URL ?? "").trim();
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const PICNIC_EMAIL = (process.env.PICNIC_USERNAME ?? "").trim();
const PICNIC_PASSWORD = process.env.PICNIC_PASSWORD ?? "";
const COUNTRY = process.env.PICNIC_COUNTRY_CODE ?? "NL";
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const SESSION_FILE = process.env.PICNIC_SESSION_FILE ?? `${DATA_DIR}/picnic-session.json`;
const SESSION_OWNER_FILE = `${DATA_DIR}/picnic-session.owner`;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 50;
const flag = (name) => /^(true|yes|1|on)$/i.test(process.env[name] ?? "");
// Escape hatch for running the dashboard outside Supervisor (local dev).
const ALLOW_ANY_INGRESS_SOURCE = flag("ALLOW_ANY_INGRESS_SOURCE");

function log(level, msg, extra) {
  const order = { debug: 0, info: 1, warning: 2, error: 3 };
  if ((order[level] ?? 1) < (order[LOG_LEVEL] ?? 1)) return;
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }) + "\n");
}

/** "/picnic", "picnic/", " /picnic " → "/picnic"; "" or "/" → "". */
function normalisePrefix(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
    log("error", "path_prefix may only contain letters, digits and . _ ~ - (and / between segments); serving at the root instead", { path_prefix: raw });
    return "";
  }
  return `/${trimmed}`;
}
const PREFIX = normalisePrefix(process.env.PATH_PREFIX ?? "/");

// The public origin OAuth discovery advertises, from the operator's mcp_url
// rather than from the request, whose forwarded Host the caller controls.
const PUBLIC_ORIGIN = (() => {
  if (!MCP_URL) return "";
  try {
    const url = new URL(MCP_URL);
    const expected = `${PREFIX}/mcp`;
    if (url.pathname.replace(/\/+$/, "") !== expected) {
      log("warning", `mcp_url's path is "${url.pathname}" but this add-on serves MCP at "${expected}" — clients must use the latter`, { mcp_url: MCP_URL });
    }
    return url.origin;
  } catch {
    log("warning", "mcp_url is not a valid URL; OAuth metadata will use the request host instead", { mcp_url: MCP_URL });
    return "";
  }
})();

let FORWARD_TARGET = null;
let forwardConfigError = "";
try {
  FORWARD_TARGET = parseForwardTarget(process.env.FORWARD_TO);
  if (FORWARD_TARGET && !PREFIX) {
    forwardConfigError = "forwarding needs a path_prefix such as /picnic: at the root this add-on owns every path, so nothing would be left to forward";
    FORWARD_TARGET = null;
  }
} catch (err) {
  forwardConfigError = err.message;
}
if (forwardConfigError) log("error", `forward_other_paths_to ignored: ${forwardConfigError}`);

/* ------------------------------------------------------------------ */
/* Tool policy                                                        */
/* ------------------------------------------------------------------ */

// Every upstream tool this add-on has reviewed, by group. Upstream's own
// annotations are too sparse to decide on (only cart mutations carry them),
// so the classification lives here. A tool not listed is withheld: when a
// future upstream pin adds one, it stays unpublished until it is reviewed
// and added, rather than appearing with unknown side effects.
const TOOL_GROUPS = {
  shopping: {
    option: null, // always on: reading the catalogue, recipes, cart and deliveries
    label: "Producten, recepten, winkelwagen en bezorgingen bekijken",
    tools: [
      "picnic_search", "picnic_get_promotions", "picnic_get_suggestions", "picnic_get_product_details",
      "picnic_get_image", "picnic_get_recipe", "picnic_browse_recipes", "picnic_get_saved_recipes",
      "picnic_get_own_recipes", "picnic_get_recipe_ingredients", "picnic_get_multiple_recipe_ingredients",
      "picnic_build_shopping_list", "picnic_find_meal_combinations", "picnic_get_cart",
      "picnic_get_delivery_slots", "picnic_get_deliveries", "picnic_get_delivery",
      "picnic_get_delivery_position", "picnic_get_delivery_scenario", "picnic_get_order_status",
    ],
  },
  cart: {
    option: "ALLOW_CART_CHANGES",
    label: "Winkelwagen aanpassen en recepten bewaren",
    tools: [
      "picnic_add_to_cart", "picnic_remove_from_cart", "picnic_clear_cart",
      "picnic_add_recipe_to_cart", "picnic_remove_recipe_from_cart",
      "picnic_save_recipe", "picnic_unsave_recipe",
    ],
  },
  delivery: {
    option: "ALLOW_DELIVERY_CHANGES",
    label: "Bezorgmoment kiezen, bezorging annuleren of beoordelen, factuur mailen",
    tools: [
      "picnic_set_delivery_slot", "picnic_cancel_delivery", "picnic_rate_delivery",
      "picnic_send_delivery_invoice_email",
    ],
  },
  account: {
    option: "ALLOW_ACCOUNT_DETAILS",
    label: "Accountgegevens, betaalprofiel en portemonnee-transacties lezen",
    tools: [
      "picnic_get_user_details", "picnic_get_user_info", "picnic_get_payment_profile",
      "picnic_get_wallet_transactions", "picnic_get_wallet_transaction_details",
    ],
  },
  twofa: {
    option: "EXPOSE_2FA_TOOLS",
    label: "2FA-code via de assistent aanvragen en invoeren (normaal via deze pagina)",
    tools: ["picnic_generate_2fa_code", "picnic_verify_2fa_code"],
  },
};

const groupOfTool = new Map();
for (const [group, def] of Object.entries(TOOL_GROUPS)) {
  for (const tool of def.tools) groupOfTool.set(tool, group);
}
const groupEnabled = (group) => {
  const option = TOOL_GROUPS[group].option;
  return option === null || flag(option);
};

// The registry keeps its tools in a private Map. Removing withheld tools
// from it once, before any MCP server exists, means upstream's own
// tools/list and tools/call handlers can be reused unchanged: a withheld
// tool is neither listed nor callable. If a future upstream refactor moves
// that Map, fail loudly rather than publish everything.
const registryMap = toolRegistry.tools;
if (!(registryMap instanceof Map)) {
  log("error", "Upstream's tool registry layout changed; refusing to start without tool gating. Bump this add-on.");
  process.exit(1);
}

const publishedTools = [];
const withheldTools = [];
for (const name of [...registryMap.keys()]) {
  const group = groupOfTool.get(name);
  if (!group) {
    withheldTools.push({ tool: name, reason: "niet beoordeeld door deze add-on (nieuw in upstream)" });
    registryMap.delete(name);
  } else if (!groupEnabled(group)) {
    withheldTools.push({ tool: name, reason: `uitgeschakeld: ${TOOL_GROUPS[group].option.toLowerCase()}` });
    registryMap.delete(name);
  } else {
    publishedTools.push(name);
  }
}
const unknownTools = withheldTools.filter((t) => t.reason.startsWith("niet")).map((t) => t.tool);
if (unknownTools.length) {
  log("warning", "Upstream registers tools this add-on doesn't know; they are withheld", { tools: unknownTools });
}
log("info", "Tool set resolved at startup", {
  published: publishedTools.length,
  withheld: withheldTools.map((t) => t.tool),
});

/* ------------------------------------------------------------------ */
/* Picnic login state                                                 */
/* ------------------------------------------------------------------ */

const STATE_LABEL = {
  starting: "bezig met starten",
  not_configured: "geen inloggegevens ingesteld",
  logging_in: "bezig met inloggen",
  ready: "ingelogd",
  needs_2fa: "wacht op 2FA-code",
  failed: "inloggen mislukt",
};
const picnic = { state: "starting", detail: "", since: Date.now() };
let loginInFlight = null;
let last2faSentAt = 0;

function setState(state, detail = "") {
  Object.assign(picnic, { state, detail, since: Date.now() });
  log(state === "failed" ? "error" : "info", `Picnic: ${STATE_LABEL[state]}`, detail ? { detail } : undefined);
}

function errorText(err) {
  const msg = err?.message ?? String(err);
  // Never let a credential end up on the dashboard or in the log via an
  // error message that echoes the request.
  return PICNIC_PASSWORD ? msg.split(PICNIC_PASSWORD).join("••••") : msg;
}

const looksLike2fa = (err) => /2fa|mfa|second[_ ]factor|otp|verif/i.test(`${err?.message ?? ""} ${err?.code ?? ""} ${err?.type ?? ""}`);

// The session file belongs to one account. If the operator switches account
// or country, upstream would happily reuse the old session; drop it instead.
function sessionOwnerId() {
  return createHash("sha256").update(`${PICNIC_EMAIL.toLowerCase()}|${COUNTRY}`).digest("hex");
}
function discardSessionIfForeign() {
  let owner = "";
  try { owner = fs.readFileSync(SESSION_OWNER_FILE, "utf8").trim(); } catch { /* none yet */ }
  if (owner && owner === sessionOwnerId()) return;
  try {
    fs.unlinkSync(SESSION_FILE);
    if (owner) log("info", "Picnic account or country changed; discarded the previous session");
  } catch { /* nothing to discard */ }
}
function markSessionOwner() {
  try { fs.writeFileSync(SESSION_OWNER_FILE, sessionOwnerId(), { mode: 0o600 }); } catch { /* best effort */ }
}

/** Confirms the client can actually make an authenticated call. */
async function confirmLoggedIn() {
  try {
    await getPicnicClient().cart.getCart();
  } catch (err) {
    if (looksLike2fa(err) || (err?.status ?? err?.statusCode) === 401 || (err?.status ?? err?.statusCode) === 403) {
      setState("needs_2fa", "Picnic vraagt om een tweede factor. Vraag hieronder een code aan en vul die in.");
    } else {
      setState("failed", errorText(err));
    }
    return false;
  }
  await saveSession().catch(() => undefined);
  try { fs.chmodSync(SESSION_FILE, 0o600); } catch { /* best effort */ }
  markSessionOwner();
  setState("ready");
  return true;
}

function login({ fresh = false } = {}) {
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    if (!PICNIC_EMAIL || !PICNIC_PASSWORD) {
      setState("not_configured", "Vul picnic_email en picnic_password in op het tabblad Configuratie en herstart de add-on.");
      return;
    }
    setState("logging_in");
    try {
      if (fresh) await resetPicnicClient();
      discardSessionIfForeign();
      await initializePicnicClient();
    } catch (err) {
      setState(looksLike2fa(err) ? "needs_2fa" : "failed", errorText(err));
      return;
    }
    await confirmLoggedIn();
  })().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

// Tools must not trigger a login of their own: upstream's handlers call
// initializePicnicClient() whenever there's no client, so with a wrong
// password every single tool call would be another failed login against
// Picnic. Refuse with an explanation the assistant can relay instead.
const TWO_FA_TOOLS = new Set(TOOL_GROUPS.twofa.tools);
const originalExecuteTool = toolRegistry.executeTool.bind(toolRegistry);
toolRegistry.executeTool = async (name, args) => {
  // Withheld or unknown: let upstream answer with its own "not found".
  if (!registryMap.has(name)) return originalExecuteTool(name, args);
  const twoFaAllowed = TWO_FA_TOOLS.has(name) && picnic.state === "needs_2fa";
  if (picnic.state !== "ready" && !twoFaAllowed) {
    return {
      content: [{
        type: "text",
        text: `Picnic is not available right now (${picnic.state}: ${picnic.detail || STATE_LABEL[picnic.state]}). ` +
          "The owner can fix this in Home Assistant: open the Picnic MCP add-on's web UI to finish the login (2FA) or check the credentials.",
      }],
      isError: true,
    };
  }
  const result = await originalExecuteTool(name, args);
  if (name === "picnic_verify_2fa_code" && !result.isError) await confirmLoggedIn();
  return result;
};

/* ------------------------------------------------------------------ */
/* MCP endpoint                                                       */
/* ------------------------------------------------------------------ */

// Upstream's base class owns all MCP request handlers (tools, prompts,
// resources); its transports are what this gateway replaces.
class SessionServerFactory extends BaseTransportServer {
  async start() {}
  async stop() {}
  create() {
    return this.createConfiguredServer();
  }
}
const serverFactory = new SessionServerFactory();

const oauth = createOAuth({
  storePath: `${DATA_DIR}/oauth-store.json`,
  basePath: PREFIX,
  publicOrigin: PUBLIC_ORIGIN,
  getAuthToken: () => AUTH_TOKEN,
  log,
});

function requireBearerAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  const valid = scheme === "Bearer" && Boolean(token) && (
    (AUTH_TOKEN && timingSafeEqualStr(token, AUTH_TOKEN)) || oauth.isValidAccessToken(token)
  );
  if (!valid) {
    // Points spec-following clients at OAuth discovery (RFC 9728 §5.1).
    res.set("WWW-Authenticate", `Bearer resource_metadata="${oauth.resourceMetadataUrl(req)}"`);
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
    return;
  }
  next();
}

const sessions = new Map(); // id → { transport, server, timer }

function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.timer);
  session.transport.close().catch(() => undefined);
  session.server.close().catch(() => undefined);
}
function touchSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => closeSession(id), SESSION_IDLE_MS);
  session.timer.unref();
}

async function handleMcp(req, res) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or expired session" }, id: null });
      return;
    }
    touchSession(sessionId);
    await session.transport.handleRequest(req, res, req.body);
    if (req.method === "DELETE") closeSession(sessionId);
    return;
  }

  if (req.method !== "POST" || !isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Start a session with an initialize request (POST)" }, id: null });
    return;
  }
  if (sessions.size >= MAX_SESSIONS) {
    // Evict the least recently created rather than refusing new clients.
    closeSession(sessions.keys().next().value);
  }

  const server = serverFactory.create();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server, timer: null });
      touchSession(id);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) closeSession(transport.sessionId);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/* ------------------------------------------------------------------ */
/* Public app (MCP port)                                              */
/* ------------------------------------------------------------------ */

const app = express();
// The tunnel terminates TLS and sends X-Forwarded-Proto; without this the
// OAuth fallback URLs would say http://.
app.set("trust proxy", true);
app.disable("x-powered-by");

const forwardRequest = FORWARD_TARGET ? createForwarder(FORWARD_TARGET, log) : null;
function ownsPath(path) {
  if (!PREFIX) return true;
  return path === PREFIX || path.startsWith(`${PREFIX}/`) || oauth.ownPaths.includes(path);
}

// First, before any body parser: a forwarded request's body must stream
// through untouched.
app.use((req, res, next) => {
  if (ownsPath(req.path)) return next();
  if (forwardRequest) return forwardRequest(req, res);
  res.status(404).json({ error: "not_found", message: `This server answers under ${PREFIX}/` });
});

app.use(oauth.router);

// Liveness only, so it can stay unauthenticated on a public hostname.
app.get(`${PREFIX}/health`, (_req, res) => {
  res.json({ ok: true, name: "picnic-mcp" });
});

app.all(
  `${PREFIX}/mcp`,
  requireBearerAuth,
  express.json({ limit: "4mb" }),
  async (req, res) => {
    try {
      await handleMcp(req, res);
    } catch (err) {
      log("error", "MCP request failed", { err: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  },
);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

/* ------------------------------------------------------------------ */
/* Ingress dashboard (separate app + port, Supervisor proxy only)     */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function maskEmail(email) {
  const [user, domain] = email.split("@");
  if (!domain) return email ? "•••" : "";
  return `${user.slice(0, 1)}•••@${domain}`;
}

let forwardProbe = null;
async function refreshForwardProbe() {
  if (FORWARD_TARGET) forwardProbe = await probeForwardTarget(FORWARD_TARGET);
}

function renderDashboard(banner = "") {
  const stateClass = picnic.state === "ready" ? "ok" : picnic.state === "failed" ? "bad" : "warn";
  const mcpUrl = MCP_URL || `http://<home-assistant-host>:${PORT}${PREFIX}/mcp`;

  const twoFa = picnic.state === "needs_2fa" || picnic.state === "failed" ? `
  <h2>Tweestapsverificatie</h2>
  <p>Heeft je Picnic-account 2FA aan, vraag dan een code aan en vul die hieronder in.
  De sessie wordt daarna bewaard; je hoeft dit alleen opnieuw te doen als Picnic de sessie intrekt.</p>
  <form method="post" action="send-2fa"><div class="actions"><button type="submit">Stuur code per sms</button></div></form>
  <form method="post" action="verify-2fa" class="field">
    <input class="mono" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="code uit de sms" required>
    <button type="submit">Verifiëren</button>
  </form>` : "";

  const forwardRow = forwardConfigError
    ? `<span class="bad">● genegeerd — ${escapeHtml(forwardConfigError)}</span>`
    : !FORWARD_TARGET
    ? '<span class="off">○ uit — andere paden krijgen 404</span>'
    : forwardProbe?.reachable
    ? `<span class="ok">● ${escapeHtml(FORWARD_TARGET.origin)} bereikbaar</span>`
    : forwardProbe
    ? `<span class="bad">● ${escapeHtml(FORWARD_TARGET.origin)} niet bereikbaar (${escapeHtml(forwardProbe.error)})</span>`
    : `<span class="warn">● ${escapeHtml(FORWARD_TARGET.origin)}</span>`;

  const groupRows = Object.entries(TOOL_GROUPS).map(([group, def]) => {
    const on = groupEnabled(group);
    const option = def.option ? `<code>${escapeHtml(def.option.toLowerCase())}</code>` : "altijd aan";
    return `<tr><td>${escapeHtml(def.label)}</td><td>${option}</td><td>${on ? '<span class="ok">● aan</span>' : '<span class="off">○ uit</span>'}</td></tr>`;
  }).join("\n");

  const withheld = withheldTools.length
    ? `<ul>${withheldTools.map((t) => `<li><code>${escapeHtml(t.tool)}</code> — ${escapeHtml(t.reason)}</li>`).join("")}</ul>`
    : "<p>Geen.</p>";

  const clients = oauth.listClients();
  const clientRows = clients.length
    ? clients.map((c) => `<tr><td>${escapeHtml(c.client_name || "(naamloos)")}</td><td>${escapeHtml(c.redirect_host)}</td><td>${escapeHtml(new Date(c.created_at).toLocaleString("nl-NL"))}</td></tr>`).join("\n")
    : '<tr><td colspan="3">Nog geen clients via OAuth gekoppeld.</td></tr>';

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Picnic MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding-bottom: .3rem; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); font-size: .92rem; vertical-align: top; }
  .ok { color: #1a7f37; } .off { color: #999; } .bad { color: #c0392b; } .warn { color: #b7791f; }
  .field { display: flex; gap: .5rem; align-items: center; margin: .5rem 0; }
  .field input { flex: 1; min-width: 0; font-family: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
  button { padding: .4rem .7rem; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; cursor: pointer; }
  .small { font-size: .85rem; opacity: .8; }
  a { color: inherit; }
  .actions { margin: .6rem 0; }
  .banner { padding: .6rem .8rem; border-radius: 6px; margin: 1rem 0; font-size: .9rem; border: 1px solid currentColor; }
</style>
</head>
<body>
  <h1>Picnic MCP</h1>
  ${banner}

  <h2>Picnic-account</h2>
  <table>
    <tr><td>Account</td><td>${escapeHtml(maskEmail(PICNIC_EMAIL) || "—")} (${escapeHtml(COUNTRY)})</td></tr>
    <tr><td>Status</td><td><span class="${stateClass}">● ${escapeHtml(STATE_LABEL[picnic.state])}</span>
      ${picnic.detail ? `<br><span class="small">${escapeHtml(picnic.detail)}</span>` : ""}</td></tr>
  </table>
  ${twoFa}
  <form method="post" action="relogin" onsubmit="return confirm('Sessie weggooien en opnieuw inloggen? Bij 2FA krijg je een nieuwe code nodig.')">
    <div class="actions"><button type="submit">Opnieuw inloggen</button></div>
  </form>
  <p class="small">E-mail, wachtwoord en land stel je in op het tabblad <strong>Configuratie</strong>
  (alleen voor beheerders); daarna de add-on herstarten.</p>

  <h2>Verbinding</h2>
  <div class="field">
    <input class="mono" readonly value="${escapeHtml(mcpUrl)}" onclick="this.select()">
    <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Kopieer URL</button>
  </div>
  <table>
    <tr><td>Pad</td><td><code>${escapeHtml(PREFIX || "/")}</code> — MCP op <code>${escapeHtml(PREFIX)}/mcp</code></td></tr>
    <tr><td>Overige paden doorsturen</td><td>${forwardRow}</td></tr>
  </table>
  <p class="small">Het bearer-token staat op het tabblad <strong>Configuratie</strong> (<code>mcp_auth_token</code>).
  Clients met een header-veld sturen het als <code>Authorization: Bearer &lt;token&gt;</code>; Claude op web en
  mobiel vraagt er eenmalig om op een inlogpagina (OAuth).</p>

  <h2>Gekoppelde OAuth-clients</h2>
  <table>
    <tr><th>Client</th><th>Terug naar</th><th>Gekoppeld op</th></tr>
    ${clientRows}
  </table>
  <form method="post" action="revoke-oauth" onsubmit="return confirm('Alle via OAuth uitgegeven tokens intrekken? Gekoppelde apps moeten dan opnieuw autoriseren.')">
    <div class="actions"><button type="submit">Trek alle OAuth-tokens in</button></div>
  </form>

  <h2>Wat de assistent mag</h2>
  <table>
    <tr><th>Groep</th><th>Optie</th><th></th></tr>
    ${groupRows}
  </table>
  <p class="small">${publishedTools.length} tools gepubliceerd, ${withheldTools.length} achtergehouden. Aanpassen via
  Configuratie en een herstart.</p>
  ${withheld}

  <h2>Meer info</h2>
  <p>Documentatie staat op het tabblad <strong>Documentatie</strong> van deze add-on ·
  <a href="https://github.com/ivo-toby/mcp-picnic" target="_blank" rel="noopener">upstream mcp-picnic</a></p>
</body>
</html>`;
}

const webApp = express();
webApp.disable("x-powered-by");

// Home Assistant requires ingress apps to accept connections only from the
// Supervisor proxy. The ingress port isn't published, but it is reachable
// from other containers on the Supervisor network, and this page can trigger
// Picnic logins. Checked against the raw socket address, never a header.
const TRUSTED_INGRESS_IPS = new Set(["172.30.32.2", "127.0.0.1", "::1"]);
webApp.use((req, res, next) => {
  if (ALLOW_ANY_INGRESS_SOURCE) return next();
  const raw = req.socket.remoteAddress ?? "";
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (TRUSTED_INGRESS_IPS.has(ip)) return next();
  log("warning", "Refused a non-ingress connection to the dashboard", { from: raw });
  res.status(403).type("text/plain").send("Only reachable through Home Assistant Ingress.");
});
webApp.use(express.urlencoded({ extended: false, limit: "16kb" }));

const BANNERS = {
  sent: "Code aangevraagd — check je sms.",
  verified: "Code geaccepteerd.",
  relogin: "Opnieuw ingelogd — zie de status hieronder.",
  revoked: "Alle OAuth-tokens zijn ingetrokken.",
};

webApp.get("/", async (req, res) => {
  await refreshForwardProbe();
  let banner = "";
  const key = Object.keys(BANNERS).find((k) => req.query[k] !== undefined);
  if (key) banner = `<div class="banner ok">${escapeHtml(BANNERS[key])}</div>`;
  else if (typeof req.query.error === "string") banner = `<div class="banner bad">${escapeHtml(req.query.error)}</div>`;
  res.set("Cache-Control", "no-store");
  res.type("html").send(renderDashboard(banner));
});

// Relative redirects throughout: under ingress the page lives at
// /api/hassio_ingress/<token>/, and an absolute path would leave it.
const back = (res, query) => res.redirect(303, `.?${query}`);
const backWithError = (res, err) => back(res, `error=${encodeURIComponent(errorText(err))}`);

webApp.post("/send-2fa", async (_req, res) => {
  if (Date.now() - last2faSentAt < 60_000) {
    return backWithError(res, new Error("Er is net al een code verstuurd; wacht een minuut."));
  }
  try {
    if (picnic.state !== "needs_2fa") await login({ fresh: true });
    if (picnic.state !== "needs_2fa") return back(res, "relogin");
    last2faSentAt = Date.now();
    await getPicnicClient().auth.generate2FACode("SMS").catch((err) => {
      // Picnic answers this endpoint with an empty body, which the client
      // library reports as a JSON parse error although the code was sent.
      if (!(err instanceof SyntaxError)) throw err;
    });
    log("info", "Picnic 2FA code requested from the dashboard");
    back(res, "sent");
  } catch (err) {
    log("error", "Requesting a 2FA code failed", { err: errorText(err) });
    backWithError(res, err);
  }
});

webApp.post("/verify-2fa", async (req, res) => {
  const code = String(req.body?.code ?? "").replace(/\s+/g, "");
  if (!/^\d{4,8}$/.test(code)) return backWithError(res, new Error("Dat lijkt geen geldige code."));
  try {
    await verifyPicnic2FACode(code);
    if (await confirmLoggedIn()) return back(res, "verified");
    backWithError(res, new Error(picnic.detail || "Code geaccepteerd, maar Picnic geeft nog geen toegang."));
  } catch (err) {
    log("warning", "Picnic 2FA verification failed", { err: errorText(err) });
    backWithError(res, err);
  }
});

webApp.post("/relogin", async (_req, res) => {
  await login({ fresh: true });
  back(res, "relogin");
});

webApp.post("/revoke-oauth", (_req, res) => {
  oauth.revokeAll();
  log("info", "All OAuth-issued tokens revoked from the dashboard");
  back(res, "revoked");
});

/* ------------------------------------------------------------------ */
/* Start                                                              */
/* ------------------------------------------------------------------ */

await installFetchProxy();

const httpServer = app.listen(PORT, () => {
  log("info", `MCP endpoint listening on :${PORT}${PREFIX}/mcp`, {
    forwarding: FORWARD_TARGET ? FORWARD_TARGET.origin : "off",
  });
});
httpServer.on("error", (err) => {
  log("error", "HTTP server error", { err: String(err) });
  process.exit(1);
});

const webServer = webApp.listen(INGRESS_PORT, () => {
  log("info", `Ingress dashboard listening on :${INGRESS_PORT}`);
});
webServer.on("error", (err) => {
  log("error", "Ingress dashboard error", { err: String(err) });
});

if (!AUTH_TOKEN) log("warning", "No mcp_auth_token set — only OAuth tokens will be accepted, and nobody can approve one");

login();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutting down", { signal });
  setTimeout(() => process.exit(0), 5000).unref();
  for (const id of [...sessions.keys()]) closeSession(id);
  httpServer.close();
  webServer.close();
  httpServer.closeAllConnections?.();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

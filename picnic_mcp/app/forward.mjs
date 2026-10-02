// Streams requests this add-on doesn't own to another HTTP service — in
// practice another MCP add-on — so one public hostname can serve both.
//
// Why here and not in the tunnel: the Cloudflared add-on's locally managed
// mode has no per-path routing at all, and dashboard-managed path rules are
// regexes evaluated in order, which is easy to get subtly wrong for OAuth
// discovery paths. Pointing the hostname at this add-on and letting it hand
// everything else on works the same with every tunnel or reverse proxy.
//
// Bodies are piped in both directions, never buffered: MCP's Streamable HTTP
// transport answers with server-sent events, and buffering would stall them.
import http from "node:http";
import https from "node:https";

// RFC 9110 §7.6.1 connection-specific headers; never forwarded either way.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function stripHopByHop(headers) {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || named.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Validates the configured target. Returns a URL, or throws with a message
 * suitable for the log and the dashboard.
 */
export function parseForwardTarget(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a URL — expected something like http://<add-on hostname>:8098`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http:// and https:// targets are supported, got ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("the target must be a plain origin (optionally with a path), without credentials, query or fragment");
  }
  return url;
}

export function createForwarder(target, log) {
  const mod = target.protocol === "https:" ? https : http;
  const agent = new mod.Agent({ keepAlive: true });
  const basePath = target.pathname.replace(/\/+$/, "");

  return function forward(req, res) {
    const headers = stripHopByHop(req.headers);
    const remote = req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${remote}` : remote;
    headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "http";
    headers["x-forwarded-host"] = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
    headers.host = target.host;

    const upstream = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: `${basePath}${req.originalUrl}`,
      headers,
      agent,
    });

    upstream.on("response", (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, stripHopByHop(upRes.headers));
      // Push headers out now so an event stream starts immediately.
      res.flushHeaders();
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    });

    upstream.on("error", (err) => {
      log("warning", "Forwarding failed", { target: target.origin, path: req.path, err: String(err) });
      if (!res.headersSent) {
        res.status(502).json({ error: "bad_gateway", message: "The service this path is forwarded to did not answer." });
      } else {
        res.destroy();
      }
    });

    // Client went away mid-stream (e.g. closed an SSE stream): tear down the
    // upstream request too instead of leaking it.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
  };
}

/** Best-effort reachability probe for the dashboard. */
export async function probeForwardTarget(target, timeoutMs = 3000) {
  const basePath = target.pathname.replace(/\/+$/, "");
  try {
    const res = await fetch(`${target.origin}${basePath}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, status: res.status };
  } catch (err) {
    return { reachable: false, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

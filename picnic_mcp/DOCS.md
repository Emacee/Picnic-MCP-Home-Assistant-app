# Picnic MCP

Runs [mcp-picnic](https://github.com/ivo-toby/mcp-picnic) — an MCP server
for the Picnic grocery service — as a Home Assistant add-on, so AI
assistants can search products and recipes, manage your cart and follow your
deliveries from any device.

**Credit:** every Picnic tool and prompt is
[mcp-picnic](https://github.com/ivo-toby/mcp-picnic) by Ivo Toby (MIT). This
add-on packages it and adds authentication, OAuth, permissions and a 2FA
flow. It is an independent project, not affiliated with or endorsed by the
mcp-picnic authors or Picnic. Picnic has no public API; the tools use the
unofficial `picnic-api` client and can break when Picnic changes its app.

This add-on does not touch Home Assistant's own conversation or MCP
integration. It is a separate MCP server that happens to run on the same
machine.

## Quick start

1. **Configuration tab:** fill in `picnic_email`, `picnic_password` and
   `country_code`. Save and **start** the add-on. On first start it also
   generates a random bearer token and saves it into `mcp_auth_token`.
2. **Web UI** (sidebar entry *Picnic MCP*, or **Open Web UI**): the status
   should read *ingelogd*. If it reads *wacht op 2FA-code*, press **Stuur
   code per sms**, enter the code and press **Verifiëren**. The session is
   stored, so this is a one-time step until Picnic revokes it.
3. **Give it its own subdomain**, e.g. `picnic.example.com`, through your
   Cloudflare Tunnel — see *Exposing it to the internet*. Set `mcp_url` to
   `https://picnic.example.com/mcp`. (On your own network only?
   `http://<HA host>:8097/mcp` works without any of this.)
4. **Connect Claude** — see *Connecting a client*.

## Configuration

| Option | Description |
|---|---|
| `picnic_email`, `picnic_password` | Your Picnic login. Stored only in this add-on's options on your own host. |
| `country_code` | `NL`, `DE` or `FR`. Changing the account or country discards the stored session automatically. |
| `mcp_url` | Public URL clients use, e.g. `https://picnic.example.com/mcp`. Its origin becomes the OAuth issuer, instead of trusting the request's `Host` header. Leave blank for local use. |
| `mcp_auth_token` | Bearer token. Generated on first start if blank; set your own to override (keep it long and random). Also the password on the OAuth approval page. |
| `path_prefix` | Default `/`: MCP at `/mcp`, health at `/health`, OAuth endpoints at the root. Only change it to share a hostname — see *Advanced*. |
| `forward_other_paths_to` | Advanced, normally blank. Only used together with a `path_prefix` — see *Advanced*. |
| `allow_cart_changes` | Default **on**. Add/remove products and recipes in the cart, clear the cart, save/unsave recipes. Nothing is ordered until you check out in the app. |
| `allow_delivery_changes` | Default **off**. Choose a delivery slot, cancel or rate a delivery, e-mail an invoice. |
| `allow_account_details` | Default **off**. Read profile, payment profile and wallet transactions. |
| `expose_2fa_tools` | Default **off**. Let the assistant request and enter 2FA codes itself, instead of you doing it in the web UI. |
| `log_level` | `debug` \| `info` \| `warning` \| `error`. |

Browsing — product search, promotions, product details and images, recipes,
shopping lists, the cart, delivery slots, deliveries and their status — is
always available. Tool changes need a restart.

### How the tool set is decided

Every upstream tool is classified into one of the groups above in
`app/gateway.mjs` (`TOOL_GROUPS`). At startup, tools in disabled groups are
removed from upstream's registry before any MCP session exists, so they are
neither listed nor callable. A tool that upstream adds in a later version and
that is not yet classified here is **withheld**, logged and shown in the web
UI — an assistant never gets a tool with unknown side effects just because
the upstream pin moved.

## The web UI (Ingress)

Shows the Picnic login status, the 2FA form, a **re-login** button (throws
the stored session away and logs in again), the connection URL, the OAuth
clients you have approved with a button to revoke all their tokens, and
which tools are published or withheld.

**Ingress is not admin-only.** `panel_admin` hides the sidebar entry from
non-admins, but any logged-in Home Assistant user can open the ingress URL,
and Home Assistant doesn't tell the add-on who is looking. So the web UI
never shows the bearer token or your Picnic password, and it can't change
credentials or permissions — those live in the admin-only Configuration tab.
What any user *can* do there is request a 2FA code, re-login and revoke OAuth
tokens.

It runs on a separate, unpublished port (`8096`) and rejects every
connection that doesn't come from the Supervisor's ingress proxy, so it is
not reachable from your LAN, the tunnel or other add-ons.

## Exposing it to the internet

The MCP port is **8097**, published on the host by default (change it in the
Network tab if it clashes). It deliberately doesn't go through Home Assistant
Ingress: MCP clients need a plain URL and a token, not a browser session.

Give the add-on **its own subdomain**. It costs one extra hostname in your
tunnel and keeps it fully independent of everything else you expose.

### Cloudflare Tunnel

**Tunnel managed in the Cloudflare dashboard** (the Cloudflared add-on has a
`tunnel_token` set): in Cloudflare Zero Trust go to **Networks → Tunnels →**
your tunnel **→ Public hostnames → Add a public hostname**:

- *Subdomain* `picnic`, *Domain* your domain.
- *Service* `HTTP`, URL `<HA host>:8097` — the same LAN address your other
  hostnames point at, with port 8097. HTTP, not HTTPS: Cloudflare terminates
  TLS, and the hop inside your network is plain HTTP.

Saving creates the DNS record (a proxied `CNAME` to
`<tunnel-id>.cfargotunnel.com`).

**Tunnel configured in the Cloudflared add-on itself** (no token): add to its
`additional_hosts`:

```yaml
- hostname: picnic.example.com
  service: http://<HA host>:8097
```

Then, either way:

1. Set `mcp_url` in this add-on to `https://picnic.example.com/mcp` and
   restart it.
2. Check that `https://picnic.example.com/health` answers `{"ok":true,…}`.

### Any other reverse proxy

Give it its own hostname, forward to `<HA host>:8097`, keep the
`Authorization` header, and don't buffer responses (`proxy_buffering off;` in
nginx) — MCP streams its answers.

## Connecting a client

**Claude (web, desktop, iOS, Android):** on claude.ai go to **Settings →
Connectors → Add custom connector**, enter `https://picnic.example.com/mcp`
and press **Connect**. A page from this add-on opens asking for the bearer
token: paste `mcp_auth_token` from the Configuration tab and press
**Authorize**. The page shows where you will be sent back (`claude.ai`) — only
continue if that is right. Connectors added on claude.ai appear in the
desktop and mobile apps as well. Claude refreshes its access silently from
then on.

**Claude Code and other clients with a header field:**

```
claude mcp add --transport http picnic https://picnic.example.com/mcp \
  --header "Authorization: Bearer <mcp_auth_token>"
```

On your own network the URL can be `http://<HA host>:8097/mcp`.

**How the OAuth part works:** an unauthenticated request gets `401` with a
`WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp`; the client discovers
`/.well-known/oauth-authorization-server`, registers itself (`/register`,
RFC 7591), sends you to `/authorize`, and exchanges the code at `/token` with
PKCE. Access tokens last an hour; refresh tokens rotate on every use and
expire after 90 days without use. Revoke all of them from the web UI at any
time; the bearer token itself is unaffected.

## Advanced: sharing one hostname with another MCP add-on

Only if you really want a single hostname for several MCP servers — a
separate subdomain per add-on is simpler and keeps them independent. With
`path_prefix` set, this add-on serves everything under that prefix and can
forward every other path to another service, so one hostname carries both:

```
https://mcp.example.com/picnic/mcp   handled here
https://mcp.example.com/.well-known/oauth-*/picnic...   handled here (OAuth discovery)
https://mcp.example.com/<anything else>   forwarded to forward_other_paths_to
```

1. **Set `path_prefix: /picnic`.**
2. **Find the other add-on's address.** Open it in Home Assistant
   (**Settings → Add-ons →** the add-on). The browser's address bar ends in
   `/hassio/addon/<slug>/info`. Its hostname on the internal add-on network
   is that slug with `_` replaced by `-` — for example
   `abcd1234_dutch_open_data_mcp` becomes `abcd1234-dutch-open-data-mcp`.
   Dutch Open Data MCP listens on port 8098, so:
   ```
   forward_other_paths_to: http://abcd1234-dutch-open-data-mcp:8098
   ```
   If that name doesn't resolve, the other add-on's host port works too:
   `http://172.30.32.1:8098` (the Supervisor network's gateway is the host).
3. **Restart this add-on** and open its web UI. *Overige paden doorsturen*
   should say *bereikbaar*.
4. **Point the shared hostname at this add-on** (`<HA host>:8097`) instead of
   at the other one.
5. **Set each add-on's `mcp_url`** to its own URL on that hostname:
   `https://mcp.example.com/picnic/mcp` here, `https://mcp.example.com/mcp`
   in Dutch Open Data MCP. Restart both, and re-add a connector in Claude if
   its URL changed.
6. Check `https://mcp.example.com/picnic/health` and
   `https://mcp.example.com/health` — the second one answers from the other
   add-on.

Each server keeps its own token, OAuth clients and tools. Their OAuth
discovery documents live at different paths
(`/.well-known/oauth-authorization-server/picnic` here, the plain
`/.well-known/oauth-authorization-server` there), so they don't collide.

Forwarding streams request and response bodies without buffering, passes the
`Authorization` header through unchanged, and adds
`X-Forwarded-For/-Proto/-Host`. The trade-off: if this add-on is stopped, the
forwarded service is unreachable through that hostname too.

**Alternative without forwarding** (dashboard-managed tunnels only): two
public hostnames with the same hostname. The first with path
`^/(picnic|\.well-known/[^/]+/picnic)(/|$)` → `<HA host>:8097`, the second
without a path → the other add-on. Cloudflare evaluates them top to bottom,
so the Picnic one must be listed first. The Cloudflared add-on's own
`additional_hosts` has no path option.

## Security

### What is exposed where

Paths below are for the default `path_prefix` of `/`; with a prefix they sit
under it.

| Port / path | Reachable from | Protection |
|---|---|---|
| `8097` `/mcp` | LAN, and the internet through your tunnel | Bearer token or an OAuth access token |
| `8097` `/authorize`, `/token`, `/register`, `/.well-known/*` | Same | Public by design; approving a client needs the bearer token (throttled to 8 tries per 15 min) |
| `8097` `/health` | Same | None — returns only `{"ok":true}` |
| `8097` other paths | Same | `404`; or, with a prefix and `forward_other_paths_to`, forwarded as-is and that service's own auth applies |
| `8096` web UI | Home Assistant Ingress only | Ingress login + source-address check |

Publishing port 8097 makes it reachable from your whole LAN, tunnel or not.

### What someone with the token can do

Everything the enabled tool groups allow, as you: see your cart, order
history, delivery times and address-related delivery details; with the
defaults, change your cart. With `allow_delivery_changes` they can also
cancel or reschedule a delivery, and with `allow_account_details` read
payment and wallet information. **None of the tools can check out or pay** —
upstream has no such tool — but treat the token like a key to your Picnic
account anyway.

### Keeping it safe

- **Keep the generated token.** It is 256-bit random and the only lock on
  the public endpoint.
- **Leave the off-by-default groups off** unless you actually use them.
- **Consider Cloudflare Access** in front of the hostname for header-based
  clients. It interferes with the OAuth flow of the Claude apps, so it suits
  Claude Code and scripts best.
- **Revoke** OAuth tokens from the web UI when you lose a device; rotate the
  bearer token by setting a new one in Configuration and restarting.

### Where your data lives

The Picnic password and the bearer token live in this add-on's options
(`/data/options.json`, managed by Supervisor on your host). The Picnic
session (`picnic-session.json`), a random device id, and OAuth clients and
tokens (`oauth-store.json`) live beside it in `/data`, readable only by the
add-on, and are included in Home Assistant backups — encrypt your backups.
Nothing is written to this repository, and nothing leaves your host except
requests to Picnic's own servers.

## Development notes

- `app/gateway.mjs` is bundled with upstream's TypeScript sources by
  esbuild in the Dockerfile's build stage. It reuses upstream's tool
  registry, MCP request handlers (`BaseTransportServer`) and Picnic client,
  and replaces only upstream's HTTP transport. `app/oauth.mjs` is the OAuth
  server, `app/forward.mjs` the forwarder.
- To pick up a newer upstream: bump `MCP_PICNIC_COMMIT` in the Dockerfile,
  compare upstream's `src/tools/picnic-tools.ts` against `TOOL_GROUPS` and
  classify any new tool, bump `version` in `config.yaml`, and add a
  `CHANGELOG.md` entry. If upstream renames the registry's internal `tools`
  map, the add-on refuses to start rather than publish ungated tools.
- Local run: bundle as the Dockerfile does, then start
  `node gateway.mjs` with `DATA_DIR`, `PICNIC_*`, `MCP_AUTH_TOKEN` and
  `ALLOW_ANY_INGRESS_SOURCE=true` in the environment.

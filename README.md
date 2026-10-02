# Picnic MCP — Home Assistant add-on

Let AI assistants use your **[Picnic](https://picnic.app)** grocery account
from your own Home Assistant, over the
[Model Context Protocol](https://modelcontextprotocol.io). Ask Claude
*"plan vijf avondmaaltijden voor twee en zet de boodschappen in mijn
mandje"* or *"wanneer komt mijn bezorging?"* on your phone, laptop or the
web, and it searches products and recipes, fills your cart and checks your
deliveries. You still check out in the Picnic app yourself.

> **Powered by [mcp-picnic](https://github.com/ivo-toby/mcp-picnic) by Ivo
> Toby.** The Picnic tools — the hard part — are theirs. This add-on packages
> them for Home Assistant and adds authentication, OAuth for the Claude apps,
> a 2FA flow, tool permissions and path-based sharing of one hostname. It is
> an independent project, **not affiliated with or endorsed by the mcp-picnic
> authors or Picnic**.

## What this add-on adds

- **Authentication.** A bearer token on every MCP request, generated on first
  start, plus an OAuth 2.1 layer (dynamic client registration + PKCE) so
  Claude on the web, desktop, iOS and Android can connect with no header
  field.
- **One hostname for several MCP servers.** Everything is served under
  `/picnic`, and every other path can be forwarded to another add-on — such
  as [Dutch Open Data MCP](https://github.com/Emacee/Dutch-Open-Data-MCP---Home-Assistant-App).
  Point a single Cloudflare Tunnel hostname at this add-on and both servers
  are reachable through it.
- **Permissions.** Browsing products, recipes, the cart and deliveries is
  always available. Changing the cart is on by default; changing deliveries
  and reading account or payment details are off until you turn them on.
- **2FA and login status** in a small web UI inside Home Assistant, instead of
  a crash loop when a password is wrong.

## Install

> [!NOTE]
> HACS can't install this — it's a Supervisor add-on, so it comes from the
> **Add-on Store**.

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FEmacee%2FPicnic-MCP-Home-Assistant-app)

1. Click the button, or go to **Settings → Add-ons → Add-on Store → ⋮ →
   Repositories** and add `https://github.com/Emacee/Picnic-MCP-Home-Assistant-app`.
2. Install **Picnic MCP**, fill in your Picnic e-mail, password and country
   on the **Configuration** tab, and start it.
3. Open the add-on's web UI. If your account uses 2FA, request a code there
   and enter it.
4. Read the **Documentation** tab for connecting Claude and for exposing the
   add-on through a tunnel.

Requires a 64-bit Home Assistant OS or Supervised install (`amd64` or `aarch64`).

## Sharing one hostname with Dutch Open Data MCP

```
https://mcp.example.com/picnic/mcp  ──►  Picnic MCP (this add-on, :8097)
https://mcp.example.com/mcp         ──►  forwarded to Dutch Open Data MCP (:8098)
```

1. In this add-on, set `forward_other_paths_to` to the other add-on, e.g.
   `http://<repo-id>-dutch-open-data-mcp:8098` (the Documentation explains
   where to find that name).
2. Point your tunnel's hostname at this add-on (`http://<this add-on>:8097`)
   instead of at the other one.
3. Set `mcp_url` in each add-on to its own URL on the shared hostname.

Each server keeps its own token and its own OAuth clients. The full
walkthrough, including a Cloudflare-only alternative, is in the
Documentation tab.

## Security, briefly

This add-on can change what gets delivered to your door. Keep the generated
token (it is the only lock), leave the delivery and account groups off unless
you need them, and read the *Security* section of the documentation before
exposing it to the internet. Your Picnic password and the session live only
in the add-on's own storage on your Home Assistant; nothing is committed to
this repository or sent anywhere but Picnic.

## Credits and licence

- **[mcp-picnic](https://github.com/ivo-toby/mcp-picnic)** by **Ivo Toby** —
  every Picnic tool and prompt this add-on serves. MIT; its licence is
  retained in [`NOTICE`](NOTICE).
- It talks to Picnic through the unofficial
  [picnic-api](https://www.npmjs.com/package/picnic-api) client. Picnic does
  not offer a public API; things can break when Picnic changes its app.
- This add-on is licensed [MIT](LICENSE).

Bugs in the Picnic tools belong
[upstream](https://github.com/ivo-toby/mcp-picnic/issues); bugs in
packaging, auth, forwarding or the web UI belong here.

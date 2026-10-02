# Changelog

## 0.1.0

First release.

- Packages [mcp-picnic](https://github.com/ivo-toby/mcp-picnic) at commit
  `d235da4325f94c5e9b6284dc4324281159179127`, bundled at image build time
  with a gateway that replaces upstream's HTTP server.
- Bearer-token auth (token generated on first start and saved into the
  Configuration tab) and an OAuth 2.1 server with dynamic client
  registration, PKCE and rotating refresh tokens, for Claude's web, desktop
  and mobile apps.
- Everything served under a configurable `path_prefix` (default `/picnic`),
  including RFC 8414 / RFC 9728 discovery documents at their path-inserted
  root locations, so the add-on can share a hostname with other servers.
- `forward_other_paths_to`: streams every request outside the prefix to
  another service (e.g. the Dutch Open Data MCP add-on), so one tunnel
  hostname serves both.
- Tool groups: browsing always on; `allow_cart_changes` on by default;
  `allow_delivery_changes`, `allow_account_details` and `expose_2fa_tools`
  off by default. Tools upstream adds in a later pin stay withheld until
  they're classified here.
- Login state machine: a wrong password or pending 2FA no longer crashes
  the add-on, and tools explain the problem instead of re-trying the login
  on every call. 2FA codes and re-login from the ingress web UI.
- The Picnic session is dropped automatically when the configured account
  or country changes.

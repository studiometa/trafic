# @studiometa/trafic-agent

Server agent for DDEV preview environments — auth, scale-to-zero, and auto-start.

Part of [Trafic](https://github.com/studiometa/trafic), a tool for managing DDEV preview environments on Linux servers.

## Features

- **Forward auth** — Traefik middleware for IP whitelist, basic auth, and token auth
- **Scale-to-zero** — Automatically stop idle DDEV projects to save RAM
- **Auto-start** — Show a waiting page and restart stopped projects on request
- **Per-project config** — Override auth and idle timeout per project

## Installation

```bash
npm install -g @studiometa/trafic-agent
```

## Commands

### `trafic-agent serve`

Start the agent server.

```bash
trafic-agent serve
# or with custom config
trafic-agent serve --config /etc/trafic/config.toml
```

### `trafic-agent setup`

Interactive server setup — installs Docker, DDEV, configures DNS, and sets up the agent as a systemd service.

```bash
trafic-agent setup --tld previews.example.com
```

**Requirements:**
- Ubuntu 24.04 LTS
- Root access (for initial setup)
- Wildcard DNS pointing to the server

### `trafic-agent upgrade` / `trafic-agent update`

Upgrade the server to the latest version of `trafic-agent` in one command. `update` is an alias for `upgrade`.

Steps:
1. **Check for updates** — queries the npm registry for the latest version
2. **Install** — runs `npm install -g @studiometa/trafic-agent@latest` if a newer version is available
3. **Migrations** — runs any pending server migrations (forward-only, idempotent)
4. **Restart** — restarts the `trafic-agent` systemd service

Fresh servers set up with `trafic-agent setup` have all migrations automatically marked as applied, so migrations only run when needed on existing deployments.

```bash
# Upgrade to the latest version (recommended)
sudo trafic-agent upgrade

# Preview what would be done without making changes
sudo trafic-agent upgrade --dry-run

# List all migrations and their status (no install or restart)
trafic-agent upgrade --list
```

Example `--list` output:

```
✓ 0001__ddev_apt_repo     Migrate DDEV from manual tarball to apt repository   (applied)
✓ 0002__mkcert_ddev_user  Install mkcert CA in the ddev user trust store       (applied)
```

Migration state is stored in `/etc/trafic/.migrations.json` and updated after each individual migration, so a partial failure leaves the state consistent.

## Configuration

Create `/etc/trafic/config.toml`:

```toml
# Required: TLD for DDEV projects
tld = "previews.example.com"

# Agent HTTP server port (default: 9876)
port = 9876

# Scale-to-zero: stop idle projects after this duration
idle_timeout = "4h"

# Authentication
[auth]
default_policy = "basic"  # allow, deny, basic, or token

# Proxies in front of the agent (default: 1 = ddev-router/Traefik alone).
# Raise by one for each extra proxy: a CDN or load balancer ahead of
# Traefik makes it 2. Set this before using allowed_ips — it decides which
# X-Forwarded-For entry is treated as the client address.
trusted_proxy_hops = 1

# IP whitelist (bypasses auth)
allowed_ips = ["192.168.1.0/24", "10.0.0.0/8"]

# Bearer tokens for CI/API access
tokens = ["your-ci-token"]

# Basic auth credentials
basic_auth = ["user:password"]

# Per-hostname rules
[[auth.rules]]
match = "*.public.*"
policy = "allow"

[[auth.rules]]
match = "admin.*"
policy = "basic"
```

## Per-project configuration

Create `.ddev/config.trafic.yaml` in your project:

```yaml
# Override auth policy for this project
auth_policy: allow  # allow, deny, basic, or token

# Override idle timeout (or disable with "never")
idle_timeout: never
```

## How it works

```
HTTPS request
     │
     ▼
Traefik (DDEV router)
     │
     ├─► forwardAuth → trafic-agent
     │        │
     │        ├─► 200 OK → DDEV project
     │        └─► 401 → Basic auth prompt
     │
     └─► 502 error → errors middleware → trafic-agent
                          │
                          ├─► known project → Waiting page + auto-start
                          └─► unknown → Error page
```

The agent:
1. Handles forward auth requests from Traefik
2. Checks IP whitelist, tokens, or basic auth
3. Tracks project activity for scale-to-zero
4. Starts stopped projects when requested
5. Shows a waiting page while projects start

## Endpoints

All internal endpoints are prefixed with `__` so they cannot collide with a
project's own paths. Everything else is treated as a request for a project.

| Endpoint | Description |
|----------|-------------|
| `GET /__auth__` | Forward auth for Traefik. `200` allows, `401` prompts for basic auth |
| `GET /__status__?project=<name>` | Project status as JSON, for the waiting page to poll |
| `GET /__health__` | Agent health and version |
| anything else | Waiting page for a known project, error page otherwise |

## TLS

Traefik obtains the certificates, and `setup --email` is what turns that on:

```bash
trafic setup --host server.example.com --tld previews.example.com \
  --email admin@example.com
```

With an email, DDEV sets `use_letsencrypt=true` and Traefik requests a
certificate per project hostname on first use — previews included, since each
one gets its own router. Without an email, projects are served with a locally
trusted mkcert certificate, which is fine behind a proxy that terminates TLS
itself but shows a browser warning if used directly.

Two limits worth knowing before you rely on it:

- Let's Encrypt allows **50 new certificates per registered domain per week**.
  Each preview hostname is a new certificate, so environments that churn fast
  can hit the ceiling. Renewals do not count against it.
- Turning Let's Encrypt off does not discard certificates already issued.
  Traefik keeps them in `acme.json` in the `ddev-global-cache` volume and
  serves them again after a restart, so `configureDdev` deletes that storage
  when Let's Encrypt is disabled.

Wildcard certificates would avoid the per-hostname limit but need a DNS-01
challenge, which DDEV does not do. If you churn tens of previews a week, put a
proxy in front that can (Caddy or Traefik with a DNS provider) and disable
Let's Encrypt in DDEV so the two do not both try.

## Network exposure

**`ufw default deny incoming` does not cover the ports Docker publishes.**
Docker adds its rules to `nat/PREROUTING` and the `DOCKER` chain of `FORWARD`,
both of which are evaluated before UFW's chains. So the ports ddev-router
publishes are reachable from the internet whatever UFW says about them, and
`ufw status` will not tell you otherwise.

`setup` opens 22, 80 and 443, and 9876 for the agent from the Docker bridge
only. Those rules are accurate. What they do **not** do is close the ports
ddev-router publishes for DDEV's tools:

| Port | Service |
|------|---------|
| 8025, 8026 | Mailpit |
| 8142, 8143 | xhgui |

Those are protected by **forward auth, not by the firewall** — the middleware
is attached to every entry point ddev-router publishes, so an unauthenticated
request gets `401` on a tool port exactly as it does on 443. An earlier
version attached it only to 80 and 443, which left xhgui answering from the
internet with no authentication at all; that is fixed, and it is the reason
the middleware is attached per entry point rather than per project router.

If you want those ports closed at the network level rather than answered with
a `401`, two options actually work:

1. **A firewall in front of the server.** The packets never reach the host, so
   Docker's rules are irrelevant. On OVH dedicated servers this is the Network
   Firewall in the control panel — note it is *stateless*, so return traffic
   needs allowing explicitly. This is the recommended defence in depth. It is
   deliberately not automated: `setup` cannot create or verify it, and a tool
   that pretends to configure something it cannot check is worse than one that
   tells you to do it yourself.
2. **Rules in the `DOCKER-USER` chain**, which Docker evaluates first in
   `FORWARD` and never overwrites. Match on the pre-DNAT port
   (`-m conntrack --ctorigdstport 8025`), because by `FORWARD` the destination
   has already been rewritten to the container. Remember these live outside
   UFW: they need their own persistence across reboots, an `ip6tables`
   equivalent, and they will not show up in `ufw status`.

Binding ddev-router to loopback only (`router-bind-all-interfaces=false`)
closes everything at once, but then nothing serves the public and you need a
host proxy in front. That is a reasonable setup; it is just a different one
from what `setup` builds.

## License

MIT — see [LICENSE](https://github.com/studiometa/trafic/blob/main/LICENSE)

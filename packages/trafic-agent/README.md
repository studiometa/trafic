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

| Endpoint | Description |
|----------|-------------|
| `GET /auth` | Forward auth for Traefik |
| `GET /errors` | Error handler for stopped projects |
| `GET /status` | Health check |
| `GET /projects` | List all projects (JSON) |

## License

MIT — see [LICENSE](https://github.com/studiometa/trafic/blob/main/LICENSE)

# @studiometa/trafic-agent

Server agent for DDEV preview environments — auth, scale-to-zero, and auto-start.

Part of [Trafic](https://github.com/studiometa/trafic), a tool for managing DDEV preview environments on Linux servers.

## Features

- **Forward auth** — Traefik middleware for IP whitelist, basic auth, and token auth
- **Scale-to-zero** — Automatically stop idle DDEV projects to save RAM
- **Auto-start** — Show a waiting page and restart stopped projects on request
- **Per-project config** — Override auth and idle timeout per project
- **Backups on removal** — Dump the database and archive the upload directories before a project is removed

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

**Automatic security updates.** Setup installs `unattended-upgrades` and writes `/etc/apt/apt.conf.d/50unattended-upgrades`, allowing Ubuntu's release, security and ESM pockets plus Docker Engine (`origin=Docker`, from `download.docker.com`). Docker security releases are therefore applied daily with the rest. Note that a Docker Engine update restarts the daemon and stops running preview containers; the waiting page starts a project again on its next request. DDEV is deliberately excluded — it is updated by `trafic-agent upgrade` instead. The server never reboots on its own (`Unattended-Upgrade::Automatic-Reboot "false"`).

### `trafic-agent destroy`

Remove a project from the server. Run it as the `ddev` user, the user the service runs as. The command refuses to run as root: DDEV does not run as root, and root could leave files in the database directory that the service cannot write to.

```bash
trafic-agent destroy preview-42--my-app
# or with custom config
trafic-agent destroy preview-42--my-app --config /etc/trafic/config.toml
# back up the project first
trafic-agent destroy preview-42--my-app --backup
# give the backup up to one hour
trafic-agent destroy preview-42--my-app --backup --timeout 1h
# remove the project in 48 hours, after a backup
trafic-agent destroy preview-42--my-app --delay 48h --backup
# cancel that removal
trafic-agent destroy preview-42--my-app --cancel
# list the scheduled removals
trafic-agent destroy --list
```

Steps:
1. **Backup** (with `--backup` only) — see [Backups](#backups). If the backup fails, the command removes nothing and exits with an error
2. **DDEV** — runs `ddev delete -Oy` in the project directory (containers and volumes, no snapshot). A failure is reported as a warning and does not stop the removal
3. **Directory** — removes the project directory
4. **Database** — deletes the project's rows from the agent database (`projects`, `access_logs` and `scheduled_destroys`)

The project directory is the `approot` from DDEV's `project_list.yaml`, or `<projects_dir>/<name>` when DDEV no longer knows the project. When the directory does not exist, the command prints a warning, does not run DDEV and only deletes the project's rows from the agent database, so a retry after a failed run cleans them up. The command refuses a directory that is not inside `projects_dir`, also after it follows symbolic links, and refuses a project directory that is a symbolic link. It also refuses an empty name, `.`, `..` or a name with a `/`.

The command checks the config as `start` does, and exits with an error before it changes anything when the config is not valid (for example a relative `[backup] dir`).

`trafic destroy` runs this command over SSH.

### Scheduled removals

`trafic-agent destroy <name> --delay <duration>` removes nothing. It records the removal date (now plus the delay) in the agent database and exits. The delay uses hours, minutes and seconds: `48h`, `1h30m`, `90m`. With `--backup`, the agent backs up the project before the scheduled removal, and keeps `--timeout` as the time limit of that backup. A new `--delay` for the same project replaces the date, the backup choice and the timeout.

The agent service checks the scheduled removals every `idle_check_interval` (default `5m`). It removes each project whose date is past with the same steps as `trafic-agent destroy`. When a removal fails (for example, the backup fails), the agent logs the error, keeps the removal scheduled and tries again on the next check. A failure on one project does not stop the removal of the others.

The service makes the backup of a scheduled removal itself, inside its systemd sandbox (`ProtectSystem=strict`). The sandbox lets it write to `/var/backups/trafic`, `/home/ddev` and `/var/lib/trafic` only. When `[backup] dir` is another directory, each scheduled backup fails with a `Cannot write to the backup directory` error that names the sandbox, and the project is never removed. Keep `[backup] dir` inside one of these directories.

`trafic deploy` cancels the scheduled removal of the project it deploys. To cancel it by hand, run `trafic-agent destroy <name> --cancel`. A cancel stops a removal that is due but not started, or that is still in its backup. Once `ddev delete` has started, the project is removed. `trafic-agent destroy --list` shows the scheduled removals, soonest first.

The date is kept in the agent database, not in `.ddev/config.trafic.yaml`: the agent finds it even when DDEV no longer knows the project, and a deploy cancels it with one command.

### Backups

`trafic-agent destroy --backup` writes a backup to `<backup.dir>/<project>/<timestamp>/`, for example `/var/backups/trafic/preview-42--my-app/2026-10-14T07-40-24Z/`:

- `db.sql.gz` — the `ddev export-db` dump. Skipped when the project has no database (`omit_containers: [db]`)
- `files.tar.gz` — the upload directories, with paths relative to the project directory. Skipped when the project has none

The upload directories are the ones DDEV uses: `upload_dirs` from the project's `.ddev/config.yaml`, or the default of the project type (for example `wp-content/uploads` for WordPress). The agent reads them from `DDEV_FILES_DIRS` in the web container. Both steps need the project to run, so the agent starts a stopped project and stops it again after the backup. While it removes a project, the idle sweep does not stop it: the project has the status `destroying` in the agent database.

The backup has one time limit for the dump and the archive together: 40 minutes by default. `--timeout` sets it, as a duration such as `90s`, `10m` or `1h` (a bare number is minutes). The start and the stop of the project are not part of it. A backup that takes longer fails, and nothing is removed. `trafic destroy --backup` passes its own `--timeout` (default `10m`). A file that changes while the agent archives it (the project runs during the backup) does not fail the backup: the archive has the file as `tar` read it, and the agent prints a warning.

The agent service removes backups older than `retain_days` once an hour. It can only write to `/var/backups/trafic`, `/home/ddev` and `/var/lib/trafic`: if you set `dir` to another path, remove old backups yourself, and do not use `--delay` with `--backup` (see [Scheduled removals](#scheduled-removals)). `dir` must not be `projects_dir`, be inside it or contain it (so not `/home/ddev` itself, with the default `projects_dir`), because the removal of a project would remove its backup: the agent refuses such a config. Setup creates `/var/backups/trafic`, owned by `ddev` with mode `700`.

To restore a backup into a project:

```bash
ddev import-db --file=/var/backups/trafic/<project>/<timestamp>/db.sql.gz
tar -xzf /var/backups/trafic/<project>/<timestamp>/files.tar.gz -C <project directory>
```

### `trafic-agent upgrade` / `trafic-agent update`

Upgrade the server to the latest version of `trafic-agent` in one command. `update` is an alias for `upgrade`.

Steps:
1. **Check for updates** — queries the npm registry for the latest version
2. **Install** — runs `npm install -g @studiometa/trafic-agent@latest` if a newer version is available
3. **Migrations** — runs any pending server migrations (forward-only, idempotent)
4. **DDEV** — upgrades the `ddev` package from its apt repository, printing the version before and after. Skipped when DDEV is not installed; a failure is reported as a warning and does not stop the upgrade
5. **Restart** — restarts the `trafic-agent` systemd service

DDEV is updated here rather than by `unattended-upgrades` on purpose: a DDEV major landing unattended can break running previews, so it happens when an operator runs the command and can watch the result.

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

# Backups made by `trafic-agent destroy --backup`
[backup]
dir = "/var/backups/trafic"  # default
retain_days = 14             # default; older backups are removed

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

# Optional: one wildcard certificate instead of one per preview.
# See the TLS section below.
[tls]
dns_provider = "cloudflare"

[tls.dns_env]
CF_DNS_API_TOKEN = "..."
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
6. Removes projects whose [scheduled removal](#scheduled-removals) is due

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

Without an email, projects are served with a locally trusted mkcert
certificate, which is fine behind a proxy that terminates TLS itself but shows
a browser warning if used directly.

There are two modes.

### Per-host certificates (default)

DDEV puts `certResolver: acme-tlsChallenge` on every project router, so
Traefik asks Let's Encrypt for one certificate per project hostname on first
use — previews included.

Let's Encrypt allows **50 new certificates per registered domain per 7 days**.
Each preview hostname is a new certificate, so an environment that churns fast
hits the ceiling, and every host that misses out is served with Traefik's
self-signed default certificate until the window clears. Renewals do not count
against the limit.

### Wildcard certificate (DNS-01)

One `*.<tld>` certificate covers every preview, so the per-hostname quota
stops being a factor. It needs a DNS-01 challenge, which needs an API token
for the DNS zone.

```toml
[tls]
# Provider name from the Traefik/lego DNS provider list
dns_provider = "cloudflare"

# Optional: use the Let's Encrypt staging CA for a first test
# ca_server = "https://acme-staging-v02.api.letsencrypt.org/directory"

[tls.dns_env]
CF_DNS_API_TOKEN = "..."
```

`setup` can write that section for you:

```bash
trafic setup --host server.example.com --tld previews.example.com \
  --email admin@example.com \
  --dns-provider cloudflare --dns-env CF_DNS_API_TOKEN=...
```

`--email` is required with `--dns-provider`: Let's Encrypt refuses an ACME
account without one. The credentials land in
`/home/ddev/.ddev/router-compose.trafic.yaml` (mode 600), which is what puts
them in the router container's environment where lego reads them.

**Rollout on an existing server:**

1. Add the `[tls]` section to `/etc/trafic/config.toml`
2. Run `sudo trafic-agent upgrade`

Migration `0016__wildcard_dns_challenge` writes the Traefik files, removes the
router container and starts one running project. DDEV regenerates the static
config on any project start, but reads `router-compose.*.yaml` only when it
recreates the router, so the removal is what gets the credentials into the
container. The router is back within seconds. With no project running, the
next deploy applies it. `trafic-agent audit` reports whether the certificate
was issued.

The first order takes about a minute after the router starts: lego waits for
the challenge record to propagate before Let's Encrypt looks for it.

**What the agent writes:**

| File | Purpose |
|------|---------|
| `~/.ddev/traefik/static_config.trafic.yaml` | The `acme-dns` resolver, its storage and the DNS challenge settings |
| `~/.ddev/traefik/custom-global-config/0-trafic-tls.yaml` | The default TLS store asking for `<tld>` and `*.<tld>` |
| `~/.ddev/router-compose.trafic.yaml` | The provider credentials on the router container |

The `0-` prefix is load-bearing. Traefik's file provider keeps the **first**
`tls.stores.default` it reads in directory order and logs "TLS store default
already configured, skipping" for every later file — and DDEV writes an empty
one in `default_config.yaml`.

`use_letsencrypt` stays on, and DDEV keeps writing a certificate resolver on
every project router. That costs nothing: Traefik skips a per-host ACME
request once the default store already holds a certificate matching the host,
wildcards included. So the quota use stops on its own as soon as the wildcard
is issued.

**Token scope, and the spare-zone pattern.** For Cloudflare the token needs
`Zone:DNS:Edit` on the zone holding the TXT record. That is a token that can
rewrite DNS for a production zone, sitting on a preview server. lego follows
CNAMEs when it looks for `_acme-challenge`, so the challenge can be delegated
to a zone nothing else uses:

```
_acme-challenge.previews.example.com.  CNAME  _acme-challenge.example-acme.net.
```

Scope the token to `example-acme.net` alone. A leak then costs a throwaway
zone rather than the production one.

**`*.<tld>` covers one label only.** `*.previews.example.com` matches
`my-app.previews.example.com` but not `a.b.previews.example.com`. A preview
name with a dot in it falls back to per-host issuance.

**A first test should use staging.** Set `ca_server` to
`https://acme-staging-v02.api.letsencrypt.org/directory`, run the rollout and
check the router log. Staging certificates are not trusted by browsers — that
is the point: a wrong token or an unreachable zone costs nothing in quota.
Switching to production afterwards is the case below.

**Changing `[tls]` later.** Editing `ca_server` or the DNS provider only
changes the config file. The Traefik files carry the old values until they are
rewritten, which today means re-running `setup` — the migration runs once per
server and does nothing on a second `upgrade`. A staging certificate also has
to be discarded before the switch to production: Traefik keeps it in
`acme-dns.json` in the `ddev-global-cache` volume and serves it until renewal,
so delete that file as well.

### Turning Let's Encrypt off

Disabling it does not discard certificates already issued. Traefik keeps them
in `acme.json` in the `ddev-global-cache` volume and serves them again after a
restart, so `configureDdev` deletes that storage when Let's Encrypt is
disabled.

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

Both layers now apply:

1. **`DOCKER-USER` rules**, installed by `setup`. That is the chain Docker
   jumps to first in `FORWARD` and never flushes, so it is the only host-level
   hook that can filter a published port. The rules drop traffic to the tool
   ports unless it comes from Docker's own networks. They match on the
   *original* destination port (`-m conntrack --ctorigdstport`), because by
   `FORWARD` the destination has already been rewritten to the container.

   They live in `/usr/local/sbin/trafic-docker-firewall`, reapplied at boot and
   after any Docker restart by `trafic-docker-firewall.service` — Docker
   recreates `DOCKER-USER` empty and nothing else would restore them.
   **They will not appear in `ufw status`.** Inspect them with
   `iptables -S DOCKER-USER`.

2. **Forward auth**, attached to every entry point ddev-router publishes, so a
   request that does reach a tool port still needs credentials. An earlier
   version attached it only to 80 and 443, which left xhgui answering from the
   internet with no authentication at all.

Access from the host itself is unaffected: a connection to `127.0.0.1:8026`
goes through Docker's userland proxy rather than `FORWARD`, so an SSH tunnel
still works:

```bash
ssh -L 8026:127.0.0.1:8026 ddev@server.example.com
# then open https://localhost:8026
```

### A provider firewall is not a substitute

Recommended as an extra layer, but do not rely on it alone. Measured on an OVH
dedicated server with the Edge Firewall enabled and a correct rule denying
these ports: a connection from **another host inside OVH** still completed in
113ms, while a port with nothing listening was dropped and timed out at 12s.
The deny applies to traffic crossing the provider's edge; traffic that never
crosses it is not filtered.

Anyone able to rent a VM from the same provider is inside that blind spot,
which for a large host is a very low bar. That is why the `DOCKER-USER` rules
above exist: they apply to every packet regardless of origin.

On OVH the setting is the Network Firewall in the control panel. Two things to
know: it is *stateless*, so `permit tcp established` is required or return
traffic for outbound connections is dropped, and it is IPv4-only. `setup` does
not configure it — it can neither create nor verify it.

Binding ddev-router to loopback only (`router-bind-all-interfaces=false`)
closes everything at once, but then nothing serves the public and you need a
host proxy in front. That is a reasonable setup; it is just a different one
from what `setup` builds.

## License

MIT — see [LICENSE](https://github.com/studiometa/trafic/blob/main/LICENSE)

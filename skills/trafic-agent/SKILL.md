---
name: trafic-agent
description: Operate a Trafic preview server with trafic-agent (@studiometa/trafic-agent), the service that runs next to DDEV and Traefik. Covers setup flags, the trafic-agent systemd service and its logs, upgrade and migrations, audit, destroy (--backup, --timeout, --delay, --cancel, --list), the keys of /etc/trafic/config.toml (auth, idle timeout, max_running_projects, [backup], [tls]) and the per-project .ddev/config.trafic.yaml. Use when you install, configure, upgrade, debug or clean up a server that hosts DDEV previews deployed with trafic, or when you edit its config.toml.
license: MIT
---

# trafic-agent

`trafic-agent` runs on the server that hosts the DDEV previews. It does these jobs:

- Forward authentication for Traefik: IP allowlist, bearer tokens, basic auth, rules per hostname.
- Scale-to-zero: it stops idle projects, and starts a stopped project on its next request behind a waiting page.
- A limit on the number of running projects (`max_running_projects`).
- Project removal, with an optional backup, now or at a scheduled date.

This file can be older or newer than the agent on the server. `trafic-agent skill` prints the copy of this skill that matches the installed version: run it on the server and prefer its content when it differs.

## Users and files

| Item | Value |
|---|---|
| Service | `trafic-agent.service`, runs `trafic-agent start --config /etc/trafic/config.toml` as user `ddev` |
| Config | `/etc/trafic/config.toml`, mode `640`, owner `root:ddev`. Edit it as root |
| Database | `/var/lib/trafic/db.sqlite` (projects, access logs, scheduled removals), owned by `ddev` |
| Migration state | `/etc/trafic/.migrations.json` |
| Projects | `/home/ddev/www/<project>` (`projects_dir`) |
| Backups | `/var/backups/trafic/<project>/<timestamp>/` (`[backup] dir`), owner `ddev`, mode `700` |
| HTTP port | `9876` (`port`), open to the Docker bridge only |

Which user runs which command:

- As root (or with `sudo`): `setup`, `upgrade`, `audit`, edits of `config.toml`, `systemctl`. The `ddev` user has no general sudo.
- As `ddev`: `destroy`. It refuses to run as root, because DDEV does not run as root and root could leave files in the database directory that the service cannot write.
- As any user: `upgrade --list`, `version`, `help`, `skill`.

## Service and logs

```bash
sudo systemctl status trafic-agent
sudo systemctl restart trafic-agent       # after each edit of config.toml
journalctl -u trafic-agent -f             # follow the logs
journalctl -u trafic-agent -n 200 --no-pager
curl -s http://127.0.0.1:9876/__health__  # agent health and version
```

The unit has a systemd sandbox (`ProtectSystem=strict`). The service can write only to `/var/lib/trafic`, `/home/ddev` and `/var/backups/trafic`. When the config is not valid, `start` prints `Configuration errors:` with one line per error, exits with code 1, and systemd restarts it every 5 seconds. Read the journal, fix the config, restart.

## `trafic-agent setup`

Run as root on a fresh Ubuntu 24.04 server, or remotely with `trafic setup` from the CLI. It installs Docker, DDEV and Node.js, configures DDEV and Traefik for forward auth, writes `/etc/trafic/config.toml` (only when it does not exist), creates the systemd service and hardens the server (SSH, UFW, Fail2ban, unattended-upgrades). It also adds `DOCKER-USER` firewall rules: from outside Docker's networks, only the router ports (80 and 443) of the ports Docker publishes stay open; tool and add-on ports are closed. It asks no questions. A second run is safe: each step is skipped when the server is already in the target state.

```bash
sudo trafic-agent setup --tld=previews.example.com --email=admin@example.com
```

| Flag | Use |
|---|---|
| `--tld` | Domain of the previews. Required on the first run. A second run reads `tld` from the config |
| `--email` | Let's Encrypt email. Without it, projects use a mkcert certificate |
| `--dns-provider <lego name>` | One wildcard `*.<tld>` certificate through DNS-01. Requires `--email`, also on a second run that reads it from the config |
| `--dns-env KEY=VALUE` | Credential of the DNS provider, repeatable |
| `--ssh-users <list>` | Users that SSH allows, comma-separated. Default `ddev` |
| `--trusted-proxy-hops <n>` | `2` when a CDN or load balancer is in front of Traefik. Written to a new config only |
| `--no-hardening`, `--no-root-ssh`, `--no-docker`, `--no-ddev` | Skip or change these steps. With `--no-root-ssh`, only the rescue mode of the provider can recover root access |
| `--dry-run` | Show what setup would do |

Setup does not create the wildcard DNS record (`*.<tld>` to the server IP) and does not add SSH keys. Add CI keys to `/home/ddev/.ssh/authorized_keys`.

A second run applies the flags you give it, not the flags of the first run. Pass the same `--email`, `--ssh-users`, `--no-root-ssh` and `--no-*` flags again: without `--email`, it turns Let's Encrypt off and deletes the issued certificates; without `--ssh-users`, SSH allows only `ddev`, root and the user who ran `sudo`. It reads only `tld` and `[tls]` from the config.

When the config exists, setup does not change it. With a new `--dns-provider`, it prints the `[tls]` section to add by hand.

## `trafic-agent upgrade`

`update` is an alias.

```bash
trafic-agent upgrade --list        # migrations and their status, no change
sudo trafic-agent upgrade --dry-run
sudo trafic-agent upgrade
```

Steps: install the latest `@studiometa/trafic-agent` from npm when it is newer, run the pending migrations, upgrade the `ddev` apt package (a failure is only a warning), restart the running DDEV projects when the DDEV version changed, restart `trafic-agent`.

- Upgrade the agent **before** you raise the CLI version in CI. `trafic deploy` and `trafic destroy` call `trafic-agent destroy` on the server, and an older agent does not know the new options.
- Migrations fix the state of existing servers. They run once per server, in order, and the state file records each one after it succeeds. A fresh `setup` marks all of them as applied.
- DDEV is upgraded only here, never by unattended-upgrades, so that a new major version does not break previews without an operator.
- A running project keeps its old containers (for example the old PHP of `ddev-webserver`) until it restarts. When the DDEV version changed, the upgrade downloads the new images with `ddev utility download-images`, then runs `ddev restart` on each running project, one at a time. Stopped and paused projects get the new images at their next start. During its restart, a project has the status `starting`, so the idle sweep does not stop it. A failed restart is only a warning, and the upgrade lists the failures at the end. `--dry-run` shows the projects it would restart.
- The first restart after a DDEV version change can recreate `ddev-router`, so all previews can stop for a few seconds, one time.

## `trafic-agent audit`

```bash
sudo trafic-agent audit
```

Run it as root. `ufw status` and the files under `/var/lib/docker` need root, so as another user the firewall and wildcard certificate checks fail. It checks SSH, the firewall, Fail2ban, automatic updates, the agent service, Docker, disk usage, the permissions of the config, the owner of the projects directory and, with a `[tls]` section, the wildcard certificate and the permissions of its credentials. It exits with code 1 when a check fails, and each failed check prints a fix.

The `Update run` check runs `unattended-upgrade --dry-run --verbose`, which downloads the pending updates but installs nothing. It fails when the run cannot parse `/etc/apt/apt.conf.d/50unattended-upgrades` or stops with a Python traceback. As another user than root, it only warns.

Setup writes that file: Ubuntu's release, security, updates and ESM pockets in `Allowed-Origins` (`origin:archive` pairs only), Docker Engine and Node.js from NodeSource in `Origins-Pattern`. DDEV is not in it.

## `trafic-agent destroy`

Run it as `ddev`. `trafic destroy` from the CLI runs the same command over SSH.

```bash
trafic-agent destroy preview-42--my-app
trafic-agent destroy preview-42--my-app --backup
trafic-agent destroy preview-42--my-app --backup --timeout 1h
trafic-agent destroy preview-42--my-app --delay 48h --backup
trafic-agent destroy preview-42--my-app --cancel
trafic-agent destroy --list
```

Steps: backup (with `--backup`; if it fails, nothing is removed), `ddev delete -Oy` (a failure is only a warning), removal of the project directory, removal of the project's rows in the agent database.

| Flag | Use |
|---|---|
| `-c`, `--config` | Config file. Default: first of `/etc/trafic/config.toml`, `./config.toml`, `./trafic.toml` |
| `--backup` | Dump the database (`db.sql.gz`) and archive the upload directories (`files.tar.gz`) to `<backup dir>/<project>/<timestamp>/` first. The agent starts a stopped project for the backup and stops it again |
| `--timeout <duration>` | Time limit of the dump and the archive together. Default `40m`. `10m`, `90s`, `1h`; a bare number is minutes |
| `--delay <duration>` | Remove nothing now. Record a removal at now plus the delay. Hours, minutes and seconds, in that order, no spaces: `48h`, `1h30m`, `90m` |
| `--cancel` | Cancel the scheduled removal of the project |
| `--list` | List the scheduled removals, soonest first. `in progress` marks a removal that has started |

Safety rules of the command:

- It refuses a project directory outside `projects_dir`, also after it follows symbolic links, and a project directory that is a symbolic link. It refuses an empty name, `.`, `..` and names with `/`.
- When the directory does not exist, it only deletes the database rows. So you can run it again after a failed removal.
- The service deletes by itself the rows of projects that DDEV no longer lists, when it starts and at each idle sweep. A project removed with `ddev delete` by hand needs no `destroy`.
- It checks the config as `start` does, and stops before any change when the config is not valid.

Scheduled removals:

- The service checks them every `idle_check_interval`, and removes each project whose date is past with the same steps.
- A failed scheduled removal is logged in the journal and tried again at the next check. A removal that fails after its backup does not back up again.
- `trafic deploy` cancels the scheduled removal of the project it deploys. After the backup, the agent marks the removal as started, just before `ddev delete`. From then on, `--cancel` and a deploy fail with `the removal of <project> is in progress`.
- The service makes the backup of a scheduled removal inside its sandbox. If `[backup] dir` is outside `/var/backups/trafic`, `/home/ddev` and `/var/lib/trafic`, each scheduled backup fails with `Cannot write to the backup directory` and the project is never removed.

Restore a backup:

```bash
cd <project directory>
ddev import-db --file=/var/backups/trafic/<project>/<timestamp>/db.sql.gz
tar -xzf /var/backups/trafic/<project>/<timestamp>/files.tar.gz -C <project directory>
```

## `config.toml`

Edit `/etc/trafic/config.toml` as root, then `sudo systemctl restart trafic-agent`. Values not in the file take their default.

| Key | Default | Use |
|---|---|---|
| `tld` | none, required | Domain of the previews |
| `port` | `9876` | Agent HTTP port |
| `db_path` | `/var/lib/trafic/db.sqlite` | Agent database |
| `project_list_path` | `/home/ddev/.ddev/project_list.yaml` | DDEV project list, watched for changes |
| `projects_dir` | `/home/ddev/www` | Must be the same as `trafic deploy --projects-dir` (default `~/www`). `destroy` never removes a directory outside it |
| `idle_timeout` | `30m` (setup writes `4h`) | Stop a project after this time without requests |
| `idle_check_interval` | `5m` | Interval of the idle sweep, the running limit and the scheduled removals |
| `max_running_projects` | `0` (no limit) | Most projects that run at the same time. See below |
| `[backup] dir` | `/var/backups/trafic` | Absolute path. Must not be `projects_dir`, be inside it or contain it (so not `/home/ddev`) |
| `[backup] retain_days` | `14` | The service removes older backups once an hour. Whole number, 1 or more |
| `[auth] default_policy` | `basic` | `allow`, `deny`, `basic` or `token`. `basic` also accepts the tokens |
| `[auth] trusted_proxy_hops` | `1` | Proxies in front of the agent. `2` with a CDN. Set it before `allowed_ips` |
| `[auth] allowed_ips` | `[]` | IPs or CIDR ranges that skip authentication |
| `[auth] tokens` | `[]` | Bearer tokens, sent as `Authorization: Bearer <token>` |
| `[auth] basic_auth` | `[]` | `"user:password"` strings, or `{ username, password }` tables |
| `[[auth.rules]]` | none | `match` (hostname glob), `policy`, optional `tokens` and `allowed_ips`. First match wins, after the global `allowed_ips` |
| `[tls] dns_provider`, `ca_server`, `[tls.dns_env]` | none | Wildcard certificate through DNS-01. A restart does not apply a change: migration `0016__wildcard_dns_challenge` applies a first `[tls]` on a server set up before it (`sudo trafic-agent upgrade`); otherwise run `sudo trafic-agent setup` again with the flags of the first run |

Example:

```toml
tld = "previews.example.com"
projects_dir = "/home/ddev/www"
idle_timeout = "4h"
idle_check_interval = "5m"
max_running_projects = 8

[backup]
dir = "/var/backups/trafic"
retain_days = 14

[auth]
default_policy = "basic"
trusted_proxy_hops = 1
allowed_ips = ["203.0.113.0/24"]
tokens = ["ci-token"]
basic_auth = ["preview:change-me"]

[[auth.rules]]
match = "*.public.*"
policy = "allow"
```

Validation errors that stop `start` and `destroy`: `tld is required`, `port must be between 1 and 65535`, `max_running_projects must be a whole number, 0 or more`, `auth.default_policy must be ...`, `backup.dir must be an absolute path`, `backup.dir must not be projects_dir, be inside it or contain it`, `backup.retain_days must be a whole number of 1 or more`, and errors on `tls.dns_env` keys.

## `max_running_projects`

- Before the waiting page starts a stopped project, the agent counts the running projects and the projects it is starting. Over the limit, it stops the projects with the oldest access first.
- `trafic deploy` starts projects without the agent. The idle sweep then stops the projects with the oldest access until the server is under the limit.
- Projects with `idle_timeout: never` are never stopped by this rule. If no other project can stop, the agent starts the project anyway and logs a warning.
- A project that `destroy` is removing is never stopped by this rule or by the idle sweep.

## Per-project config: `.ddev/config.trafic.yaml`

Committed in the project repository. Flat `key: value` lines only.

```yaml
auth_policy: allow   # allow, deny, basic or token
idle_timeout: never  # or a duration such as 2h
```

- `idle_timeout` replaces the global value for this project, shorter or longer. The idle sweep reads it at each check.
- `auth_policy` replaces only `default_policy`. The global `allowed_ips` and a matching `[[auth.rules]]` still apply first. The agent reads it when it starts and when DDEV's `project_list.yaml` changes; after a change, restart the service.

## Troubleshooting

| Symptom | Check and fix |
|---|---|
| Service restarts in a loop | `journalctl -u trafic-agent -n 50`. Fix the `Configuration errors:` lines, then restart |
| Preview asks for a password | `default_policy = "basic"`. Add the client IP to `allowed_ips`, a rule, or `auth_policy: allow` in the project |
| `allowed_ips` does not match | `trusted_proxy_hops` is wrong. Use `2` behind a CDN |
| Preview stays on the waiting page | `ddev list`, then `ddev start` in the project directory to see the DDEV error. Check `max_running_projects` and the journal |
| Project stops too soon | Raise `idle_timeout`, or set `idle_timeout: never` in the project |
| `cannot read ... (EACCES): connect as the ddev user` | Run `destroy` as `ddev`, not as another user |
| `Refusing to remove ...: it is not inside the projects directory` | Set `projects_dir` to the directory that `trafic deploy` uses |
| `The backup timed out ...` | Run again with a larger `--timeout`, for example `1h` |
| `Cannot write to the backup directory` | Put `[backup] dir` in `/var/backups/trafic`, `/home/ddev` (not `projects_dir`) or `/var/lib/trafic`, owned by `ddev` |
| Certificate warning on previews | `sudo trafic-agent audit`. Without `--email` at setup, projects use mkcert. Per-host certificates are limited to 50 new ones per domain per week; use `[tls]` for one wildcard |
| `Unable to parse Unattended-Upgrade::Allowed-Origins` in `/var/log/unattended-upgrades/unattended-upgrades.log` | No update is installed. Servers set up or upgraded with 0.1.43 to 0.1.52 have this error: run `sudo trafic-agent upgrade` (migration `0021__fix_unattended_upgrades_origins`), then `sudo trafic-agent audit` |
| A port other than 80 or 443 answers from outside (Mailpit, xhgui, or an add-on port such as Elasticsearch on 9200) | An older server closes only the tool ports. Run `sudo trafic-agent upgrade` (migration `0022__docker_user_default_deny`). Then `sudo iptables -S TRAFIC-DOCKER-USER` shows a `DROP` rule after the router ports, and `sudo systemctl status trafic-docker-firewall` is active. Reach an add-on port with an SSH tunnel to `127.0.0.1:<port>` |

## CI side

For the CI jobs that call this server (`trafic deploy`, `trafic destroy`), use the `trafic-cli` skill, or run `trafic skill` with the CLI version that CI uses.

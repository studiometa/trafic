# @studiometa/trafic-cli

CLI to deploy projects to DDEV servers — preview environments from CI.

Part of [Trafic](https://github.com/studiometa/trafic), a tool for managing DDEV preview environments on Linux servers.

## Installation

```bash
npm install -g @studiometa/trafic-cli
# or use directly with npx
npx @studiometa/trafic-cli deploy ...
```

## Commands

### `trafic setup`

Setup a new server over SSH. Run it from any machine that can reach the server with SSH — the command bootstraps Node.js, installs [`@studiometa/trafic-agent`](../trafic-agent/) on the server, then runs `trafic-agent setup` there.

```bash
trafic setup \
  --host server.example.com \
  --tld previews.example.com \
  --email admin@example.com
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--host` | SSH host (required) | - |
| `--tld` | TLD for DDEV projects (required) | - |
| `--email` | Email for Let's Encrypt certificates | - |
| `--user` | SSH user | `root` |
| `--port` | SSH port | `22` |
| `--agent-version` | Agent version to install | `latest` |
| `--ssh-users` | SSH users to allow after hardening, comma-separated. The `--user` value is always added | `ddev` |
| `--trusted-proxy-hops` | Proxies in front of the agent — `2` behind a CDN. Fresh installs only | `1` |
| `--no-hardening` | Skip server hardening | `false` |
| `--no-root-ssh` | Disable root SSH login. Refused when connecting as `root` | `false` |
| `--no-docker` | Skip Docker installation | `false` |
| `--no-ddev` | Skip DDEV installation | `false` |
| `--dry-run` | Print the remote commands without running them | `false` |
| `--ssh-options` | Extra SSH options | - |

**Requirements:**

- Ubuntu 24.04 LTS on the target server (26.04 also verified)
- SSH access as `root`, or as a user with **passwordless** sudo — SSH runs in batch mode, so a password prompt cannot be answered
- With `--no-root-ssh`, connect as a sudo user: root is dropped from `AllowUsers` and `PermitRootLogin` becomes `no`, leaving the provider's rescue mode as the only recovery path
- Wildcard DNS (`*.previews.example.com` → server IP)

The command is safe to run again: each step is skipped when the server is already in the target state.

### `trafic deploy`

Deploy a project to a DDEV server.

```bash
trafic deploy \
  --host server.example.com \
  --name my-project \
  --sync "dist/" \
  --script "composer install --no-dev"
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--host` | SSH host (required) | - |
| `--name` | Project name (required) | - |
| `--user` | SSH user | `ddev` |
| `--port` | SSH port | `22` |
| `--sync` | Comma-separated local paths to sync. Directories and files both work | `.` |
| `--script` | Post-sync script to run in DDEV | - |
| `--env` | Environment for `--script`, repeatable. `KEY=VALUE`, or bare `KEY` to take the runner's value | - |
| `--before-script` | Script to run before deploy (on server, outside the container) | - |
| `--after-script` | Script to run after deploy (on server, outside the container) | - |
| `--create-script` | Script to run only on the deploy that creates the project (on server) | - |
| `--timeout` | Per-command timeout, e.g. `10m`, `90s`, `1h` | `10m` |
| `--branch` | Git branch name | auto-detected from CI |
| `--preview` | Preview environment ID (MR/PR number) | - |
| `--repo` | Repository URL | auto-detected from CI |
| `--ssh-options` | Extra SSH options | - |

### `trafic destroy`

Remove a DDEV project from the server.

```bash
trafic destroy \
  --host server.example.com \
  --name my-project \
  --preview 123
```

## CI Examples

### GitLab CI

```yaml
deploy_preview:
  stage: deploy
  image: node:24
  before_script:
    - eval $(ssh-agent -s)
    - ssh-add "$SSH_PRIVATE_KEY"
  script:
    - npx @studiometa/trafic-cli deploy
        --host $SSH_HOST
        --name $CI_PROJECT_PATH_SLUG
        --preview $CI_MERGE_REQUEST_IID
        --sync "dist/"
  rules:
    - if: $CI_MERGE_REQUEST_ID
```

### GitHub Actions

```yaml
deploy_preview:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: webfactory/ssh-agent@v0.9.0
      with:
        ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
    - run: npx @studiometa/trafic-cli deploy
        --host ${{ vars.SSH_HOST }}
        --name ${{ github.event.repository.name }}
        --preview ${{ github.event.pull_request.number }}
        --sync "dist/"
```

## How it works

The setup command executes 5 steps over SSH:

1. **Check the server** — Read the OS, resolve root or sudo privileges
2. **Install Node.js** — Install Node.js 24 from the NodeSource apt repository (skipped when already present)
3. **Install the agent** — `npm install -g @studiometa/trafic-agent`
4. **Setup the server** — Run `trafic-agent setup` (Docker, DDEV, Traefik, systemd, hardening)
5. **Verify** — Check that the `trafic-agent` service is active

The deploy command executes 8 steps over SSH:

1. **Update source code** — Clone the repository, or fetch and check out the branch when it is already there. A clone also writes `.ddev/config.local.yaml` with the project name and the server's router ports, read from `ddev config global`
2. **Start DDEV** — Run `ddev start` unless the project is already running
3. **Before-script** — Optional, on the server, outside the container
4. **Rsync files** — Sync local paths to the server. A directory is mirrored with `--delete`, so a file the build stops producing is removed from the server too; a single file is copied as itself. A path that does not exist stops the deploy
5. **Create-script** — Optional, on the server, and **only on the deploy that created the project**. For one-time seeding such as `ddev pull`, which overwrites the database and so must not repeat
6. **Run script** — Optional, inside the container, with `--env` values available to it
7. **After-script** — Optional, on the server, outside the container
8. **Verify** — Run `ddev describe` and return the project URL

### Seeding a database once

A preview environment starts with an empty database. `--create-script` runs on the deploy that created the project and never again, which is what a `ddev pull` provider needs — it overwrites the database it imports into, so repeating it on every deploy would discard the environment's content:

```bash
trafic deploy \
  --host server.example.com \
  --name my-app \
  --preview 42 \
  --sync "vendor,dist" \
  --create-script "ddev pull prod-db -y" \
  --timeout 30m
```

Raise `--timeout` when the pull is slow: it applies per remote command, and a timeout partway through an import leaves the environment half-built.

## Zero dependencies

This package has no runtime dependencies. It uses native Node.js APIs (`node:child_process`) for SSH and rsync operations.

## License

MIT — see [LICENSE](https://github.com/studiometa/trafic/blob/main/LICENSE)

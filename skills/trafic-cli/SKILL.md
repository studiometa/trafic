---
name: trafic-cli
description: Write and fix CI jobs that deploy DDEV preview environments with the trafic CLI (@studiometa/trafic-cli). Covers trafic setup, trafic deploy, trafic destroy (with --backup and --delay), their options, GitLab CI and GitHub Actions patterns, preview names and URLs, and the errors these commands print with their fixes. Use when a .gitlab-ci.yml or a GitHub Actions workflow runs `trafic` or `npx @studiometa/trafic-cli`, when a preview deploy or destroy job fails, or when you add preview environments to a DDEV project.
license: MIT
---

# trafic CLI

`trafic` deploys DDEV projects to a Linux server from CI, over SSH and rsync. On the server, the `trafic-agent` service handles authentication, scale-to-zero and removals. The CLI has three commands:

- `trafic setup`: provision a server (run once, from any machine with SSH access as root or a sudo user).
- `trafic deploy`: create or update a project on the server (run from CI).
- `trafic destroy`: remove a project, now or after a delay (run from CI).

This file can be older or newer than the CLI that your CI runs. `trafic skill` prints the copy of this skill that matches the installed version: run `npx @studiometa/trafic-cli@<version> skill` and prefer its content when it differs.

## Before you write a job

1. Find the version of the agent on the server: `ssh ddev@<host> trafic-agent --version`.
2. Pin the CLI to that version in CI: `npx @studiometa/trafic-cli@<version> deploy ...`. Use `@latest` only if you upgrade the server together with it.
3. **Upgrade the agent before the CLI.** `trafic deploy` and `trafic destroy` run `trafic-agent destroy` on the server. An older agent does not know the new options, and the job fails. On the server, run `sudo trafic-agent upgrade` (as a user with sudo, not as `ddev`), then raise the CLI version in CI.
4. The runner needs Node.js 24 or later, `ssh`, and `rsync` when you use `--sync`.

## Project names and URLs

- `--name` is the DDEV project name. Use lowercase letters, digits and hyphens: the name is a hostname label.
- `--preview <iid>` changes the project name to `preview-<iid>--<name>`. Pass the same `--name` and `--preview` to `deploy` and `destroy`.
- The URL is `https://<project name>.<tld>`, for example `https://preview-42--my-app.previews.example.com`. The `<tld>` is the `--tld` of `trafic setup`.
- The project directory on the server is `<projects-dir>/<project name>`, by default `~/www/<project name>` (`/home/ddev/www/...`).

## `trafic deploy`

```bash
trafic deploy --host server.example.com --name my-app --preview 42 \
  --sync "dist/,vendor" --script "composer install --no-dev"
```

Steps on the server, in this order:

1. Cancel a removal that `trafic destroy --delay` scheduled (`trafic-agent destroy <project> --cancel`).
2. Clone the repository at `--branch`, or fetch and check out the branch when the clone exists. The first clone writes `.ddev/config.local.yaml` with the project name and the router ports of the server.
3. `ddev start`, unless the project runs or `--no-start` is set.
4. `--before-script`, on the server, outside the container.
5. Rsync each `--sync` path. A directory is mirrored with `--delete`. A path that does not exist stops the deploy.
6. `--create-script`, on the server, only on the deploy that created the project.
7. `--script`, inside the web container, with the `--env` values.
8. `--after-script`, on the server, outside the container.
9. `ddev describe`. A failure here is logged and does not fail the deploy.

| Option | Use |
|---|---|
| `--host` | SSH host (required) |
| `--name` | Project name (required) |
| `--preview <iid>` | MR or PR number. The project becomes `preview-<iid>--<name>` |
| `--branch` | Branch to clone. Default: `$CI_COMMIT_REF_NAME` or `$GITHUB_REF_NAME` |
| `--repo` | Repository URL. Default: `$CI_REPOSITORY_URL`, or `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git` |
| `--sync <paths>` | Comma-separated local paths to send: build output, `vendor`. Nothing is sent without it |
| `--script <cmd>` | Command inside the web container (`composer install`, `wp cache flush`, migrations) |
| `--env KEY=VALUE` / `--env KEY` | Environment for `--script`, repeatable. A bare `KEY` takes the value from the runner, so a secret is not in the command line |
| `--before-script`, `--after-script` | Commands on the server, outside the container, in the project directory |
| `--create-script <cmd>` | Command on the server, on the first deploy only. Use it for `ddev pull <provider> -y` or another one-time seed |
| `--timeout` | Time limit of each remote command: `10m` (default), `90s`, `1h`. A bare number is minutes |
| `--projects-dir` | Default `~/www`. Must be the same as `projects_dir` in the agent config |
| `--no-start` | Do not run `ddev start` |
| `--user` | Default `ddev`. Keep it: the agent refuses to run `destroy` as root |
| `--port` | SSH port, default `22` |
| `--ssh-options` | Extra SSH options. Use the `=` form: `--ssh-options="-i $KEY -o IdentitiesOnly=yes"` |

Rules:

- Build in CI, then send the result with `--sync`. The server clones the repository, so only send files that git does not track (build output, `vendor`, `node_modules` that the site needs).
- Put commands that need PHP, Composer or the database in `--script`. Put commands that need `ddev` itself (`ddev pull`, `ddev import-db`) in `--create-script`, `--before-script` or `--after-script`.
- Raise `--timeout` for a slow step, such as a large `ddev pull`. It applies to each remote command, not to the whole deploy.
- A `--create-script` that fails runs again on the next deploy. One that succeeded never runs again for this project.

## `trafic destroy`

```bash
trafic destroy --host server.example.com --name my-app --preview 42
trafic destroy --host server.example.com --name my-app --preview 42 --backup
trafic destroy --host server.example.com --name my-app --preview 42 --delay 48h --backup
```

The CLI runs `trafic-agent destroy <project>` on the server. The agent deletes the DDEV project (`ddev delete -Oy`), the project directory and the project's records in its database. It finds the directory from its own `projects_dir`, so `destroy` has no `--projects-dir` option.

| Option | Use |
|---|---|
| `--host`, `--name` | Required |
| `--preview <iid>` | Same value as in `deploy` |
| `--backup` | Dump the database and archive the upload directories first, on the server (`/var/backups/trafic/<project>/<timestamp>/` by default). If the backup fails, nothing is removed and the job fails |
| `--delay <duration>` | Remove nothing now. The agent removes the project after the delay. Hours, minutes and seconds only, in that order, no spaces: `48h`, `1h30m`, `90m`. Not `2d`, not `1h30` |
| `--timeout` | Default `10m`. Without `--backup`: time limit of the remote command. With `--backup`: time limit of the backup on the server, and the SSH command gets 10 more minutes. Raise it for a large database or large uploads |
| `--user`, `--port`, `--ssh-options` | As in `deploy` |

With `--delay`, a new `trafic deploy` of the same project cancels the removal. A new `--delay` for the same project replaces the date. Use `--delay` after a merge, to keep the preview for a short time.

## `trafic setup`

Run it once per server, from a machine that can connect as root or as a user with passwordless sudo. It installs Node.js 24, the agent (`--agent-version`, default `latest`), Docker, DDEV and Traefik, writes `/etc/trafic/config.toml`, starts the `trafic-agent` service and hardens the server. Running it again is safe, but it applies the flags you give it: pass the same `--email`, `--ssh-users` and `--no-*` flags as the first run. Without `--email`, a second run turns Let's Encrypt off.

```bash
trafic setup --host server.example.com --tld previews.example.com --email admin@example.com
```

| Option | Use |
|---|---|
| `--tld` | Domain of the previews (required). Point the wildcard DNS `*.<tld>` to the server first |
| `--email` | Let's Encrypt email. Without it, projects get a mkcert certificate that browsers do not trust |
| `--dns-provider <lego name>` + `--dns-env KEY=VALUE` | One wildcard certificate through DNS-01, instead of one certificate per preview (Let's Encrypt allows 50 new certificates per domain per week). Requires `--email` |
| `--user` | Default `root` for `setup` |
| `--ssh-users` | Users that SSH allows after hardening, default `ddev`. `--user` is always added |
| `--no-root-ssh` | Disable root login. Refused when you connect as root |
| `--trusted-proxy-hops` | `2` when a CDN is in front of the server. Fresh installs only |
| `--no-hardening`, `--no-docker`, `--no-ddev` | Skip these steps |
| `--dry-run` | Print the remote commands only |

After setup, add the public key of the CI to `/home/ddev/.ssh/authorized_keys` on the server.

## GitLab CI

Use a file-type CI variable for the key, and point ssh to it. Do not start `ssh-agent`: GitLab runs `after_script` in another shell, the agent survives, and the job stays `running` after its script ends.

```yaml
.trafic:
  image: node:24
  before_script:
    - chmod 600 "$SSH_PRIVATE_KEY"
  rules:
    - if: $CI_MERGE_REQUEST_IID

deploy_preview:
  extends: .trafic
  stage: deploy
  script:
    - npx @studiometa/trafic-cli@<version> deploy
        --host $SSH_HOST
        --name $CI_PROJECT_PATH_SLUG
        --preview $CI_MERGE_REQUEST_IID
        --ssh-options="-i $SSH_PRIVATE_KEY -o IdentitiesOnly=yes"
        --sync "dist/"
        --script "composer install --no-dev"
  environment:
    name: preview/$CI_MERGE_REQUEST_IID
    url: https://preview-$CI_MERGE_REQUEST_IID--$CI_PROJECT_PATH_SLUG.previews.example.com
    on_stop: destroy_preview

destroy_preview:
  extends: .trafic
  stage: deploy
  when: manual
  variables:
    GIT_STRATEGY: none
  script:
    - npx @studiometa/trafic-cli@<version> destroy
        --host $SSH_HOST
        --name $CI_PROJECT_PATH_SLUG
        --preview $CI_MERGE_REQUEST_IID
        --ssh-options="-i $SSH_PRIVATE_KEY -o IdentitiesOnly=yes"
        --delay 48h
  environment:
    name: preview/$CI_MERGE_REQUEST_IID
    action: stop
```

- `$CI_PROJECT_PATH_SLUG` is a safe `--name`: lowercase, hyphens only.
- The build job must pass its output to `deploy_preview` (`artifacts` and `needs`), or `--sync` fails.
- For a branch or main deploy without `--preview`, set `--name` and `--branch` and use another rule.

## GitHub Actions

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  deploy_preview:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci && npm run build
      - uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
      - run: npx @studiometa/trafic-cli@<version> deploy
          --host ${{ vars.SSH_HOST }}
          --name ${{ github.event.repository.name }}
          --preview ${{ github.event.pull_request.number }}
          --branch ${{ github.head_ref }}
          --sync "dist/"

  destroy_preview:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
      - run: npx @studiometa/trafic-cli@<version> destroy
          --host ${{ vars.SSH_HOST }}
          --name ${{ github.event.repository.name }}
          --preview ${{ github.event.pull_request.number }}
```

- Always pass `--branch ${{ github.head_ref }}` on `pull_request` events. There, `GITHUB_REF_NAME` is `<number>/merge`, which the server cannot clone.
- `ssh-agent` is safe on GitHub Actions. The GitLab warning does not apply.
- If the repository name has capitals, dots or underscores, give `--name` a lowercase value with hyphens.

## Errors and fixes

| Error | Cause and fix |
|---|---|
| `Option '--ssh-options' argument is ambiguous` | The value starts with a dash. Write `--ssh-options="-i key ..."` with `=` |
| `Permission denied (publickey)` | The CI key is not in `/home/ddev/.ssh/authorized_keys`, or the SSH user is not in `--ssh-users` of setup. SSH runs in batch mode and cannot ask for a password |
| `Missing --branch and could not detect from CI environment` | Pass `--branch`. Also pass it on GitHub `pull_request` events (see above) |
| `Cannot sync "<path>": no such file or directory. Did the build produce it?` | The build did not run in this job, or its artifacts did not reach it. Fix `artifacts`/`needs`, or the path |
| `Command failed: rsync (exit code ENOENT)` | `rsync` is not installed on the runner. Install it before the deploy |
| `trafic-agent: command not found` at "Cancel a scheduled removal", or `trafic-agent is not on the PATH of ...` | The agent is not installed on the server, or not on the PATH of the SSH user. Run `trafic setup`, and connect as `ddev` |
| `Unknown command: destroy`, or `Unknown option '--cancel'` or `'--delay'` | The agent is older than the CLI. Run `sudo trafic-agent upgrade` on the server, or pin the CLI to the agent version |
| `Error: run trafic-agent destroy as the ddev user, not root` | Remove `--user root` from `deploy` and `destroy` |
| `cannot read /etc/trafic/config.toml (EACCES): connect as the ddev user` | Same cause: connect as `ddev` |
| `Refusing to remove ...: it is not inside the projects directory ...` | `--projects-dir` of deploy and `projects_dir` of the agent differ. Make them the same on the server |
| `The backup timed out ... Raise the limit with --timeout` | Raise `--timeout` of `trafic destroy --backup`, for example `--timeout 1h` |
| `the removal of <project> is in progress, it is too late to cancel it` | A delayed removal started. Wait until it ends, then deploy again: the deploy creates the project again |
| `Invalid delay: "<value>"` | Use `48h`, `1h30m` or `90m`. Days and spaces are not accepted |
| `Invalid --timeout` | Use `10m`, `90s`, `1h` or a bare number of minutes |
| `Command failed: ssh (exit code null)` after a step ran for 10 minutes | The step reached `--timeout`. Raise it, for example `--timeout 30m` |
| Preview shows a certificate warning | Setup ran without `--email` (mkcert certificate), or Let's Encrypt refused the certificate, for example over its limit of 50 per week. Set up one wildcard certificate with `--dns-provider` |

## Server side

To change the server (configuration, authentication, idle timeout, running limit, backups, upgrades), use the `trafic-agent` skill, or run `trafic-agent skill` on the server.

A project can override the authentication policy and the idle timeout in `.ddev/config.trafic.yaml`, committed in the repository:

```yaml
auth_policy: allow   # allow, deny, basic or token
idle_timeout: never  # or a duration such as 2h
```

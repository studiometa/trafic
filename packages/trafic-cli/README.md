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
| `--sync` | Local path to sync | `.` |
| `--script` | Post-sync script to run in DDEV | - |
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

The deploy command executes 7 steps over SSH:

1. **Check DDEV** — Verify DDEV is installed
2. **Create directory** — Create project directory if needed
3. **Rsync files** — Sync local files to server
4. **Configure DDEV** — Create `.ddev/config.yaml` if missing
5. **Start DDEV** — Run `ddev start`
6. **Run script** — Execute post-deploy script (optional)
7. **Get URL** — Return the project URL

## Zero dependencies

This package has no runtime dependencies. It uses native Node.js APIs (`node:child_process`) for SSH and rsync operations.

## License

MIT — see [LICENSE](https://github.com/studiometa/trafic/blob/main/LICENSE)

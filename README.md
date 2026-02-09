# 🚦 Trafic

**DDEV preview environments on any Linux server.**

Trafic turns a VPS into a preview server for your web projects. It handles authentication, scale-to-zero, auto-start, and deployments from CI — all powered by [DDEV](https://ddev.com) and [Traefik](https://traefik.io).

> ⚠️ **Work in progress** — This project is being extracted from an internal tool at [Studio Meta](https://www.studiometa.fr). See the [plan](docs/) for details.

## Features

- **DDEV-native** — No custom Dockerfiles needed. Works with WordPress, Laravel, Drupal, and any DDEV-compatible project.
- **Scale-to-zero** — Idle projects are stopped automatically to save RAM. They restart on the next request.
- **Authentication** — Forward auth via Traefik with IP whitelist, tokens, basic auth, and per-hostname rules.
- **Preview environments** — Create and destroy environments from CI, like Vercel but for PHP.
- **Simple CLI** — `setup` (server), `deploy` (CI), `status` / `logs` (ops).
- **TOML config** — Simple, readable configuration.
- **Zero vendor lock-in** — Runs on any Linux VPS with SSH access.

## How it works

```mermaid
flowchart TD
  request[HTTPS request] --> traefik[Traefik / DDEV router]
  traefik --> forwardAuth[forwardAuth → trafic agent]
  forwardAuth --> |200 OK| ddev-web[DDEV project]
  forwardAuth --> |401| basic-auth[Basic auth prompt]
  traefik --> |502 error| errors[errors middleware → trafic agent]
  errors --> |known project| waiting[Waiting page + auto-start]
  errors --> |unknown project| error-page[Error page]
```

## Quick start

```bash
# Setup a server (run on the server via SSH)
npx @studiometa/trafic-cli setup --tld=previews.example.com

# Deploy from CI
npx @studiometa/trafic-cli deploy \
  --host=server.example.com \
  --name=my-app \
  --branch=main \
  --sync="dist/" \
  --script="composer install --no-dev"

# Your app is live at https://my-app.previews.example.com
```

## Packages

| Package                                          | Description                          |
| ------------------------------------------------ | ------------------------------------ |
| [`@studiometa/trafic-cli`](packages/trafic-cli/) | CLI for deploying projects from CI   |
| [`@studiometa/trafic-agent`](packages/trafic-agent/) | Server agent (auth, scale-to-zero) |

## Documentation

- [Architecture & open-source plan](docs/open-source-plan.md)
- [Deploy CLI plan](docs/deploy-cli-plan.md)

## CI examples

<details>
<summary>GitLab CI</summary>

```yaml
deploy_preprod:
  stage: deploy
  before_script:
    - eval $(ssh-agent -s)
    - chmod 600 "$SSH_PRIVATE_KEY"
    - ssh-add "$SSH_PRIVATE_KEY"
  script:
    - npx @studiometa/trafic-cli deploy
        --host $SSH_HOST
        --name my-project
        --sync "web/wp-content/themes/starter/dist/"
        --script "composer install --no-dev"
  rules:
    - if: $CI_COMMIT_BRANCH == "develop"
```

</details>

<details>
<summary>GitHub Actions</summary>

```yaml
deploy:
  runs-on: ubuntu-latest
  if: github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "24"
    - run: npm ci && npm run build
    - uses: webfactory/ssh-agent@v0.9.0
      with:
        ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
    - run: npx @studiometa/trafic-cli deploy
        --host ${{ vars.SSH_HOST }}
        --name my-project
        --sync "dist/"
        --script "composer install --no-dev"
```

</details>

## License

[MIT](LICENSE) © [Studio Meta](https://www.studiometa.fr/)

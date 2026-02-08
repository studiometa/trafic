# Claude Instructions

## Project Overview

Trafic is a CLI tool and server agent for managing DDEV preview environments on Linux servers. It provides authentication, scale-to-zero, and CI-driven deployments powered by DDEV and Traefik.

## Monorepo Structure

```
packages/
├── trafic-cli/      # @studiometa/trafic-cli — CLI for CI (deploy, destroy, setup)
└── trafic-agent/    # @studiometa/trafic-agent — Server agent (Nitro, auth, scale-to-zero)
```

## Git & Commits

- Commit messages: English, simple verb-first sentences (e.g., "Add...", "Fix...", "Update...")
- Always add `Co-authored-by: Claude <claude@anthropic.com>` trailer
- **Tags**: Do NOT use `v` prefix (use `1.0.0` not `v1.0.0`)
- **Releases**: Created automatically by GitHub Actions when a tag is pushed

## Changelog

- **Single changelog** at root (`CHANGELOG.md`) for the entire monorepo
- Prefix entries with package name when relevant: `**CLI**: ...`, `**Agent**: ...`
- Use `[hash]` format for commit references
- Use `[#N]` format for PR references (GitHub style)
- Add link definitions at the bottom of the file

## Versioning

- Use root npm scripts to bump version across all packages:
  - `npm run version:patch`
  - `npm run version:minor`
  - `npm run version:major`

## Tech Stack

- **Node.js** >= 24
- **TypeScript** strict mode
- **Build**: Vite lib mode + `tsc --emitDeclarationOnly`
- **Test**: Vitest with coverage (v8)
- **Lint**: oxlint
- **Format**: oxfmt
- **Pre-commit**: husky + lint-staged
- **CI**: GitHub Actions
- **Dependencies**: Renovate bot

## Code Conventions

- ESM only (`"type": "module"`)
- Use `node:` prefix for builtins (`node:fs`, `node:child_process`, etc.)
- Minimize runtime dependencies — prefer native Node APIs
- TypeScript strict everywhere
- Proper `exports` field in package.json

## Architecture

### CLI (`packages/trafic-cli/`)

Runs on CI runners. Orchestrates deployments via SSH/rsync. Zero runtime dependencies (uses native `node:child_process` for SSH).

### Agent (`packages/trafic-agent/`)

Runs on the DDEV server as a systemd service. Built with Nitro (h3 + SQLite + scheduled tasks). Handles:
- Forward auth for Traefik
- Scale-to-zero (stop idle projects)
- Waiting pages (auto-start on request)
- Project discovery (watches DDEV project_list.yaml)
- TOML configuration via c12

## Plans

- [Open-source plan](docs/open-source-plan.md) — Architecture, conventions, transition plan
- [Deploy CLI plan](docs/deploy-cli-plan.md) — CLI design, SSH orchestration, CI integration

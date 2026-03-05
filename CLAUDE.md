# Claude Instructions

## Project Overview

Trafic is a CLI tool and server agent for managing DDEV preview environments on Linux servers. It provides authentication, scale-to-zero, and CI-driven deployments powered by DDEV and Traefik.

## Monorepo Structure

```
packages/
├── trafic-cli/      # @studiometa/trafic-cli — CLI for CI (deploy, destroy)
└── trafic-agent/    # @studiometa/trafic-agent — Server agent (auth, scale-to-zero, setup)
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
- **Format**: oxfmt (not currently configured)
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

Runs on CI runners. Orchestrates deployments via SSH/rsync. **Zero runtime dependencies** (uses native `node:child_process` for SSH).

Commands:
- `trafic deploy` — 7-step DDEV deployment
- `trafic destroy` — Remove project from server

### Agent (`packages/trafic-agent/`)

Runs on the DDEV server as a systemd service. Uses native Node.js HTTP server + `node:sqlite`. Handles:
- Forward auth for Traefik (IP whitelist, basic auth, tokens)
- Scale-to-zero (stop idle projects)
- Waiting pages (auto-start on request)
- Project discovery (watches DDEV project_list.yaml)
- TOML configuration via c12
- Per-project config via `.ddev/config.trafic.yaml`

Commands:
- `trafic-agent start` — Start the agent server
- `trafic-agent setup` — Server provisioning (Docker, DDEV, hardening)
- `trafic-agent upgrade` — Run pending server migrations
- `trafic-agent audit` — Security audit checks

### Agent migrations (`packages/trafic-agent/src/setup/migrations/`)

Migrations fix server state on **existing** servers when the correct behaviour changes between releases. They are forward-only and run exactly once per server.

**When to write a new migration (not edit an existing one):**
- A bug fix changes how something was installed or configured on a server (e.g. wrong path, wrong user, wrong flags)
- An existing migration has already shipped in a release — servers that ran it are in the old state and need a corrective step
- Never modify a migration that has already been released: treat released migrations as immutable

**When NOT to write a migration:**
- The change only affects fresh installs (`setup` already does the right thing)
- The change is purely in-process (config file format, database schema handled elsewhere, etc.)

**How to add a migration:**
1. Create `packages/trafic-agent/src/setup/migrations/NNNN__short_description.ts` (zero-padded 4-digit sequence)
2. Export a `const migrationNNNN... : Migration` object with `id`, `description`, and `run()`
3. `run()` **must be idempotent** — guard with an `existsSync` or equivalent condition check
4. Register it at the end of `ALL_MIGRATIONS` in `migrations/index.ts`
5. `markAllMigrationsApplied()` is called by `setup()` — fresh servers automatically skip all migrations

**Migration file naming:** `NNNN__short_description.ts` where `NNNN` is the next available 4-digit number (e.g. `0003__...` after `0002__...`).

## Testing

- **Unit tests**: `npm test` (77 tests across both packages)
- **Integration tests**: `npm run test:integration` (Docker-based SSH tests)
- **Coverage**: `npm run test:ci` (with Codecov upload in CI)

## Documentation

- [CLI README](packages/trafic-cli/README.md) — Deploy and destroy commands
- [Agent README](packages/trafic-agent/README.md) — Server setup and configuration
- [Example config](examples/config.toml) — Full configuration reference
- [Open-source plan](docs/open-source-plan.md) — Architecture, conventions
- [Deploy CLI plan](docs/deploy-cli-plan.md) — CLI design, SSH orchestration

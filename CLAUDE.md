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
- **Releases**: Do NOT tag or create GitHub releases manually — each merge into `main` releases (see Versioning)

## Changelog

- **Never edit `CHANGELOG.md` directly.** Each PR adds a fragment `.changelog/<slug>.md` (slug = branch name without its prefix, e.g. `feature/ssh-sync` → `ssh-sync.md`)
- A fragment only contains `### Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies` headings, each followed by its entries — no `#`/`##` heading
- **Do not write the PR number**: the `Release` workflow appends `([#N])` and the link definition from the merged PR that added the fragment
- Prefix entries with package name when relevant: `**CLI**: ...`, `**Agent**: ...`, `**Dev**: ...`
- Commit references are optional: `[hash]` in the entry plus its `[hash]: https://github.com/studiometa/trafic/commit/hash` link definition in the fragment
- The `Changelog` check fails when a PR changes `packages/**` without a fragment; set the `no-changelog` label for changes users do not see (tests, refactors, tooling)
- Format and tooling: [`weareikko/changelog`](https://github.com/weareikko/changelog)

## Versioning

- Each merge into `main` releases: the `Release` workflow (`publish.yml`, `weareikko/changelog` action) runs the tests, computes the version from the fragments, folds `.changelog/` into `CHANGELOG.md`, bumps all packages, commits `Release <version>`, tags (no `v` prefix), creates the GitHub release, then publishes to npm. Without a fragment, nothing is released
- Version from the fragments: on 0.x, a breaking entry gives a minor bump, any other entry a patch bump. Force a bump with `gh workflow run publish.yml -f version=major` (or `patch` / `minor`)
- Prereleases: add `.changelog/prerelease` with one identifier (`alpha`, `beta`, `rc`); each merge with fragments then releases a prerelease on the `next` npm dist-tag. Delete the file to release the stable version. See [Prereleases](https://github.com/weareikko/changelog#prereleases)
- npm trusted publishing (OIDC, no npm token) is bound to `publish.yml`: keep the publish job in that file, never call it from another workflow
- Each package has its own `JS-DevTools/npm-publish` step, which skips a version npm already has: after a failed publish, use "Re-run failed jobs"

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
- `trafic deploy` — 9-step DDEV deployment
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
- `trafic-agent destroy <name>` — Remove a project (DDEV project, directory, database rows); `trafic destroy` calls it over SSH

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

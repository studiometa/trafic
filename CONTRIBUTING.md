# Contributing to Trafic

Thank you for your interest in contributing to Trafic! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js >= 24 (use [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm))
- npm (comes with Node.js)
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/studiometa/trafic.git
cd trafic

# Install dependencies
npm install

# Run tests
npm test

# Build all packages
npm run build
```

### Project Structure

```
trafic/
├── packages/
│   ├── trafic-cli/      # CLI (setup, deploy, destroy)
│   └── trafic-agent/    # Server agent (auth, scale-to-zero, setup, destroy, backups)
├── examples/            # CI configuration examples
├── docs/                # Documentation and plans
└── .github/             # GitHub Actions workflows
```

## Development Workflow

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:ci

# Run tests in watch mode (in a specific package)
cd packages/trafic-cli
npm run test:watch

# Run the integration tests (Docker-based SSH tests)
npm run test:integration --workspace=@studiometa/trafic-cli
```

### Linting

```bash
npm run lint
```

There is no formatter yet. Follow the style of the code around your change.

### Type Checking

```bash
npm run typecheck
```

## Code Style

- **ESM only** — Use `"type": "module"` and ES imports
- **Node.js builtins** — Use `node:` prefix (`node:fs`, `node:path`, etc.)
- **TypeScript strict** — All code must pass strict type checking
- **Minimal dependencies** — Prefer native Node.js APIs over external packages
- **Zero runtime deps for CLI** — The CLI package has no runtime dependencies

## Commit Messages

- Use English, verb-first sentences: `Add...`, `Fix...`, `Update...`
- Keep the first line under 72 characters
- Reference issues when applicable: `Fix deploy timeout (#42)`

When commits are co-authored with AI:
```
Add feature description

Co-authored-by: Claude <claude@anthropic.com>
```

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with clear, atomic commits
4. Ensure all tests pass: `npm test`
5. Ensure the lint and type checks pass: `npm run lint && npm run typecheck`
6. Add a changelog fragment in `.changelog/` (see [Changelog](#changelog))
7. Push and open a PR against `main`

### PR Checklist

- [ ] Tests added/updated for new functionality
- [ ] Documentation updated if needed
- [ ] Changelog fragment added in `.changelog/` (if user-facing change), or the `no-changelog` label set
- [ ] All CI checks pass

## Changelog

Do not edit `CHANGELOG.md`. Add a fragment in `.changelog/<slug>.md`, where the slug is your branch name without its prefix. Use `###` Keep a Changelog sections and prefix entries with the package name:

```markdown
### Added

- **CLI**: Add a `--dry-run` option to `deploy`

### Fixed

- **Agent**: Fix the idle timeout of a project with a custom config
```

Do not write the pull request number: the release adds it. A pull request that changes `packages/` needs a fragment, unless it has the `no-changelog` label. See [`weareikko/changelog`](https://github.com/weareikko/changelog) for the format.

## Releases

All packages share one version. Each merge into `main` releases what its fragments describe: the `Release` workflow (`.github/workflows/publish.yml`) runs the tests, then the [`weareikko/changelog`](https://github.com/weareikko/changelog#release-1) action computes the next version, folds the fragments into `CHANGELOG.md`, bumps the version of all packages, commits `Release X.Y.Z`, tags `X.Y.Z` (no `v` prefix), pushes and creates the GitHub release. The workflow then publishes the packages to npm. Merged Renovate pull requests become `Dependencies` entries. Without a fragment or a Renovate pull request since the last release, nothing is released.

The version comes from the entries. On 0.x, a breaking entry (`- **CLI**: Breaking: …`) gives a minor version and any other entry a patch version. To force a bump, run the workflow from the Actions tab or with:

```bash
gh workflow run publish.yml -f version=minor   # or patch / major
```

### Prereleases

A pull request that adds `.changelog/prerelease` with one identifier (`alpha`, `beta` or `rc`) starts prereleases: each next merge with entries releases a prerelease (`0.1.49-beta.0`, then `0.1.49-beta.1`, …). A pull request that deletes the file releases the stable version on its merge. See [Prereleases](https://github.com/weareikko/changelog#prereleases).

A prerelease is published on the `next` npm dist-tag and as a GitHub prerelease. Any other version is published on `latest`. Install a prerelease with `npm install @studiometa/trafic-cli@next`.

### Publishing

npm trusted publishing (OIDC) publishes the packages from `publish.yml`: there is no npm token. Keep the publish job in that file. Each package has its own publish step, and a step skips a version that npm already has. When a publish fails (for example on a network error), use "Re-run failed jobs" on the run: it publishes the packages that are still missing.

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- For questions, open a discussion

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

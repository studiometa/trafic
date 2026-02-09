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
│   ├── trafic-cli/      # CLI for CI (deploy, destroy)
│   └── trafic-agent/    # Server agent (auth, scale-to-zero)
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
```

### Linting and Formatting

```bash
# Lint code
npm run lint

# Check formatting
npm run format:check

# Fix formatting
npm run format
```

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
5. Ensure code is formatted: `npm run format`
6. Push and open a PR against `main`

### PR Checklist

- [ ] Tests added/updated for new functionality
- [ ] Documentation updated if needed
- [ ] Changelog entry added (if user-facing change)
- [ ] All CI checks pass

## Changelog

We maintain a single `CHANGELOG.md` at the root of the monorepo. When adding entries:

- Prefix with package name: `**CLI**: ...`, `**Agent**: ...`
- Use `[hash]` format for commit references
- Use `[#N]` format for PR references
- Add link definitions at the bottom of the file

## Versioning

Version bumps are done from the root and sync across all packages:

```bash
npm run version:patch  # 0.1.0 → 0.1.1
npm run version:minor  # 0.1.0 → 0.2.0
npm run version:major  # 0.1.0 → 1.0.0
```

Tags are created without `v` prefix: `1.0.0`, not `v1.0.0`.

## Releases

Releases are automated via GitHub Actions when a tag is pushed:

```bash
# After bumping version
git add .
git commit -m "Bump version to X.Y.Z"
git tag X.Y.Z
git push && git push --tags
```

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- For questions, open a discussion

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

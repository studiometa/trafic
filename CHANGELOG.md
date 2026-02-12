# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-02-12

### Fixed

- **Agent**: Fix setup — create config and data directories ([#10])

## [0.1.4] - 2026-02-12

### Fixed

- **Agent**: Fix DDEV setup — don't start router without a project ([#9])

## [0.1.3] - 2026-02-12

### Fixed

- **Agent**: Fix DDEV install — use manual download instead of buggy install script ([#8])

## [0.1.2] - 2026-02-12

### Fixed

- **Agent**: Fix DDEV install — run as ddev user, not root ([#7])

## [0.1.1] - 2026-02-12

### Added

- Add one-liner install script for server setup ([f086115], [36bca6b])

### Fixed

- **Agent**: Fix ESM `require()` errors in setup scripts ([1012821])

## [0.1.0] - 2026-02-09

### Added

- **CLI**: `trafic deploy` command — 7-step DDEV deployment orchestration
- **CLI**: `trafic destroy` command — delete DDEV project and remove directory
- **CLI**: SSH wrapper with exec, test, and rsync over native `node:child_process`
- **CLI**: Auto-detection of repo URL and branch from GitLab CI and GitHub Actions
- **CLI**: Preview environment support with `--preview <iid>` flag
- **CLI**: Step-based logger with colored output for CI readability
- **Agent**: Forward auth middleware for Traefik (IP whitelist, basic auth, tokens)
- **Agent**: Scale-to-zero — stop idle DDEV projects automatically
- **Agent**: Auto-start — waiting page that starts stopped projects on request
- **Agent**: Per-project config via `.ddev/config.trafic.yaml`
- **Agent**: `trafic-agent setup` command for server provisioning
- **Agent**: SQLite database for project state and request tracking
- GitHub Actions CI and publish workflows
- GitLab CI and GitHub Actions deployment examples
- Agent TOML configuration example

[Unreleased]: https://github.com/studiometa/trafic/compare/0.1.5...HEAD
[0.1.5]: https://github.com/studiometa/trafic/compare/0.1.4...0.1.5
[0.1.4]: https://github.com/studiometa/trafic/compare/0.1.3...0.1.4
[0.1.3]: https://github.com/studiometa/trafic/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/studiometa/trafic/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/studiometa/trafic/compare/0.1.0...0.1.1

[#7]: https://github.com/studiometa/trafic/pull/7
[#8]: https://github.com/studiometa/trafic/pull/8
[#9]: https://github.com/studiometa/trafic/pull/9
[#10]: https://github.com/studiometa/trafic/pull/10
[0.1.0]: https://github.com/studiometa/trafic/releases/tag/0.1.0

[1012821]: https://github.com/studiometa/trafic/commit/1012821
[f086115]: https://github.com/studiometa/trafic/commit/f086115
[36bca6b]: https://github.com/studiometa/trafic/commit/36bca6b

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.17] - 2026.03.05

### Fixed

- **Agent**: Fix setup — write `/etc/sudoers.d/trafic-ddev` to allow `ddev` user to run `ddev-hostname` without a password; without this rule `ddev start` fails in non-interactive contexts (migrations, upgrade) ([02af8ff], [#24])
- **Agent**: Add migration `0004__ddev_hostname_sudoers` — writes the sudoers rule on existing servers ([8d11700], [#24])

## [0.1.16] - 2026.03.05

### Fixed

- **Agent**: Fix `upgrade` — re-exec the newly installed binary after `npm install -g` so new migrations are picked up by the new process, not the old one ([dbf7562], [#23])
- **Agent**: Fix migration `0003__ddev_router_bind_all_interfaces` — replace `ddev restart router` (invalid) with `ddev poweroff && ddev start --all` ([84a82cf], [#23])

## [0.1.15] - 2026.03.05

### Fixed

- **Agent**: Fix DDEV setup — add `--router-bind-all-interfaces=true` to `ddev config global` so the router binds on all interfaces; without this external traffic got a 521 error ([6686bc5], [#22])
- **Agent**: Add migration `0003__ddev_router_bind_all_interfaces` — enables the flag and restarts the router on existing servers ([206c7ed], [#22])

## [0.1.14] - 2026.03.04

### Added

- **Agent**: `upgrade`/`update` now performs a full self-update — checks npm registry, installs latest version if available, runs pending migrations, and restarts the systemd service ([a891c4f], [#21])
- **Agent**: `update` command as alias for `upgrade` ([a891c4f], [#21])

## [0.1.13] - 2026.03.04

### Fixed

- **Agent**: Add migration `0002__mkcert_ddev_user` — install mkcert CA in the ddev user trust store on servers provisioned before 0.1.12 ([155af84], [#20])

### Changed

- **Agent**: Revert mkcert change from migration `0001__ddev_apt_repo` — released migrations are immutable; the fix is now a standalone migration ([155af84], [#20])

## [0.1.12] - 2026.03.04

### Fixed

- **Agent**: Fix mkcert CA not found by DDEV — run `mkcert -install` with `HOME=/home/ddev` and `chown` the result to `ddev:ddev` so the CA is installed in the ddev user trust store ([304fa0b], [#19])

### Changed

- **CI**: Add `CODECOV_TOKEN` and explicit `lcov.info` file paths to Codecov upload steps ([beaeab3], [#19])

## [0.1.11] - 2026.03.04

### Added

- **Agent**: Add `trafic-agent upgrade` command — versioned, forward-only migration system to update server tooling between releases without re-running `setup` ([9279484], [df92fc8], [#18])
- **Agent**: Add `0001__ddev_apt_repo` migration — migrates DDEV from manual tarball install to official apt repository on existing servers ([df92fc8], [#18])

### Changed

- **Agent**: Replace `better-sqlite3` native addon with built-in `node:sqlite` — no more C++ compilation on install ([f5d93d5], [#17])
- **Agent**: Remove `build-essential` and `python3` from install script — no longer needed without native addons ([5724b7a], [#17])

## [0.1.10] - 2026.03.04

### Fixed

- **Agent**: Fix DDEV install — use official apt repository instead of manual tarball, ensuring `ddev-hostname` and `mkcert` are always installed ([cdf41a4], [#14])

## [0.1.9] - 2026-03-04

### Fixed

- **CLI**: Fix `ddev start` via SSH — add `DDEV_NONINTERACTIVE=true` to prevent `ddev-hostname` lookup failure ([745770b])
- **Agent**: Fix setup — silence noisy Docker install script and `systemctl` output ([982da49])
- **Agent**: Fix setup — merge `ddev config global` calls and silence output ([56ca884], [5112332])
- **Agent**: Fix install script — suppress `needrestart` prompts during apt calls ([3a057d0])

### Security

- Update rollup to patch arbitrary file write vulnerability ([GHSA-mw96-cpmx-2vgc]) ([157f822])

## [0.1.8] - 2026-03-04

### Fixed

- **Agent**: Fix setup hanging on apt installs — add `NEEDRESTART_MODE=a` to suppress interactive service restart prompts
- **Agent**: Fix SSH service reload — use `ssh` before `sshd` (Ubuntu uses `ssh.service`)
- **Agent**: Fix SSH hardening locking out root — use `PermitRootLogin prohibit-password` and keep `root` in `AllowUsers` to retain key-based root access after setup

## [0.1.7] - 2026-03-04

### Changed

- **Agent**: `setup` reads existing `/etc/trafic/config.toml` to reuse `tld` on re-runs — `--tld` is no longer required when config already exists
- **Agent**: `setup` skips writing `/etc/trafic/config.toml` if it already exists to preserve user edits

### Fixed

- **Agent**: Fix `ddev start` — set `DDEV_NONINTERACTIVE=true` in systemd service to skip `ddev-hostname` `/etc/hosts` management (see [ddev/ddev#2696])
- **Agent**: Fix setup — install system dependencies (`jq`, `curl`, `rsync`) as a first step

## [0.1.6] - 2026-02-12

### Fixed

- **Agent**: Fix systemd service — use dynamic path for agent binary ([#11])

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

[Unreleased]: https://github.com/studiometa/trafic/compare/0.1.17...HEAD
[0.1.17]: https://github.com/studiometa/trafic/compare/0.1.16...0.1.17
[0.1.16]: https://github.com/studiometa/trafic/compare/0.1.15...0.1.16
[0.1.15]: https://github.com/studiometa/trafic/compare/0.1.14...0.1.15
[0.1.14]: https://github.com/studiometa/trafic/compare/0.1.13...0.1.14
[0.1.13]: https://github.com/studiometa/trafic/compare/0.1.12...0.1.13
[0.1.12]: https://github.com/studiometa/trafic/compare/0.1.11...0.1.12
[0.1.11]: https://github.com/studiometa/trafic/compare/0.1.10...0.1.11
[0.1.10]: https://github.com/studiometa/trafic/compare/0.1.9...0.1.10
[0.1.9]: https://github.com/studiometa/trafic/compare/0.1.8...0.1.9
[0.1.8]: https://github.com/studiometa/trafic/compare/0.1.7...0.1.8
[0.1.7]: https://github.com/studiometa/trafic/compare/0.1.6...0.1.7
[0.1.6]: https://github.com/studiometa/trafic/compare/0.1.5...0.1.6
[0.1.5]: https://github.com/studiometa/trafic/compare/0.1.4...0.1.5
[0.1.4]: https://github.com/studiometa/trafic/compare/0.1.3...0.1.4
[0.1.3]: https://github.com/studiometa/trafic/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/studiometa/trafic/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/studiometa/trafic/compare/0.1.0...0.1.1

[#7]: https://github.com/studiometa/trafic/pull/7
[#8]: https://github.com/studiometa/trafic/pull/8
[#9]: https://github.com/studiometa/trafic/pull/9
[#10]: https://github.com/studiometa/trafic/pull/10
[#11]: https://github.com/studiometa/trafic/pull/11
[#14]: https://github.com/studiometa/trafic/pull/14
[#17]: https://github.com/studiometa/trafic/pull/17
[#18]: https://github.com/studiometa/trafic/pull/18
[#19]: https://github.com/studiometa/trafic/pull/19
[#20]: https://github.com/studiometa/trafic/pull/20
[#21]: https://github.com/studiometa/trafic/pull/21
[#22]: https://github.com/studiometa/trafic/pull/22
[#23]: https://github.com/studiometa/trafic/pull/23
[#24]: https://github.com/studiometa/trafic/pull/24
[GHSA-mw96-cpmx-2vgc]: https://github.com/advisories/GHSA-mw96-cpmx-2vgc
[ddev/ddev#2696]: https://github.com/ddev/ddev/issues/2696

[745770b]: https://github.com/studiometa/trafic/commit/745770b
[5112332]: https://github.com/studiometa/trafic/commit/5112332
[982da49]: https://github.com/studiometa/trafic/commit/982da49
[56ca884]: https://github.com/studiometa/trafic/commit/56ca884
[157f822]: https://github.com/studiometa/trafic/commit/157f822
[3a057d0]: https://github.com/studiometa/trafic/commit/3a057d0
[cdf41a4]: https://github.com/studiometa/trafic/commit/cdf41a4
[f5d93d5]: https://github.com/studiometa/trafic/commit/f5d93d5
[5724b7a]: https://github.com/studiometa/trafic/commit/5724b7a
[9279484]: https://github.com/studiometa/trafic/commit/9279484
[df92fc8]: https://github.com/studiometa/trafic/commit/df92fc8
[304fa0b]: https://github.com/studiometa/trafic/commit/304fa0b
[beaeab3]: https://github.com/studiometa/trafic/commit/beaeab3
[155af84]: https://github.com/studiometa/trafic/commit/155af84
[a891c4f]: https://github.com/studiometa/trafic/commit/a891c4f
[6686bc5]: https://github.com/studiometa/trafic/commit/6686bc5
[206c7ed]: https://github.com/studiometa/trafic/commit/206c7ed
[dbf7562]: https://github.com/studiometa/trafic/commit/dbf7562
[84a82cf]: https://github.com/studiometa/trafic/commit/84a82cf
[02af8ff]: https://github.com/studiometa/trafic/commit/02af8ff
[8d11700]: https://github.com/studiometa/trafic/commit/8d11700
[0.1.0]: https://github.com/studiometa/trafic/releases/tag/0.1.0

[1012821]: https://github.com/studiometa/trafic/commit/1012821
[f086115]: https://github.com/studiometa/trafic/commit/f086115
[36bca6b]: https://github.com/studiometa/trafic/commit/36bca6b

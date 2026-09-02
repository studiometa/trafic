# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.28] - 2026.09.02

### Added

- **CLI**, **Agent**: `--no-root-ssh` on `setup` — writes `PermitRootLogin no` and drops root from `AllowUsers`, leaving the provider's rescue mode as the only recovery path. Nothing in Trafic needs root over SSH: the agent runs as `ddev` under systemd, `deploy` and `destroy` connect as `ddev`, and `upgrade` uses `sudo`. Opt-in, since the default keeps a root key as an emergency route. The CLI refuses the flag when connecting as `root`, and the agent warns when there is no `$SUDO_USER` to fall back on — both being the self-lockout that [#31] fixed ([a29913e], [#35])

## [0.1.27] - 2026.09.02

### Added

- **CLI**, **Agent**: `--trusted-proxy-hops` on `setup`, so the value is written into the generated config instead of being edited afterwards. Applies to fresh installs only — an existing `/etc/trafic/config.toml` is never rewritten. A value below 1 or not a whole number is rejected with a message rather than written ([c7d62ed], [#34])
- **Agent**: `trusted_proxy_hops` in `[auth]` — how many proxies sit in front of the agent, defaulting to `1` for a plain install where only ddev-router/Traefik is ahead. Raise it by one per extra proxy; a CDN or load balancer in front of Traefik makes it `2`. An out-of-range or non-integer value falls back to the default rather than `0`, which would read the proxy's own address and stop the allowlist from ever matching ([92c72da], [#33])

### Fixed

- **CLI**: Report argument parse errors with a message and the help text. A dash-leading value such as `--trusted-proxy-hops -1` reads as another flag to `parseArgs`, which previously surfaced as a raw `TypeError` and stack trace ([c7d62ed], [#34])

### Security

- **Agent**: Fix an IP allowlist bypass. The client address was read from the leftmost `X-Forwarded-For` entry, which is whatever the client sent — Traefik appends the true peer to the right of it. Anyone who guessed an entry in `allowed_ips` could send `X-Forwarded-For: <that-ip>` and be allowed, since an IP match grants access unconditionally. The address is now taken by counting trusted proxies from the right, and the unforgeable socket peer is no longer discarded on the way to `checkAuth` ([92c72da], [#33])

## [0.1.26] - 2026.09.02

### Fixed

- **Agent**: `setup --dry-run` no longer writes files. Every setup module imported `writeFileSync` from `node:fs` directly, bypassing the dry-run aware `writeFile` in `steps.ts` — which nothing used. A dry-run attempted real writes while announcing "no changes will be made", starting with `/etc/sudoers.d/trafic-ddev` and continuing through the sshd config, systemd unit, fail2ban jail and agent config ([2f4fef6], [#32])

### Changed

- **Agent**: Setup steps take an injected `SetupIo` — `exec`, `commandExists`, file I/O and `env` — with the real implementation as the default parameter. Tests drive the steps with a plain fake instead of mocking modules, and dry-run gets a single place to intercept writes ([2f4fef6], [#32])
- **Dev**: Agent test coverage 32% → 65%. New tests for SSH hardening, UFW rules, the fail2ban jail, unattended-upgrades, system limits and file permissions, the Docker install and daemon config, the ddev user and its sudoers rule, the DDEV apt repo, Traefik forward auth, the agent config and systemd unit, and the dry-run behaviour of `steps.ts` ([2f4fef6], [#32])
- **Dev**: Exclude `test/**` from coverage reports in both packages, so test helpers no longer count as production code ([2f4fef6], [#32])

### Fixed

- **CLI**: Always add the `--user` value to `--ssh-users`. Hardening writes an `AllowUsers` directive, so connecting as a user outside that list — `--user ubuntu` with the default `--ssh-users ddev`, for instance — locked that user out on their next connection. Nothing looked wrong at the time, because reloading sshd keeps the current session alive ([#31])
- **Agent**: Always add `$SUDO_USER` to `AllowUsers` during hardening, closing the same lockout on the on-server path (`sudo trafic-agent setup`) ([#31])
- **CLI**: Print the resulting SSH access list before making changes, so a `--dry-run` shows who keeps access ([#31])

## [0.1.25] - 2026.09.02

### Changed

- **CLI**, **Agent**: Install Node.js from the NodeSource apt repository instead of fnm. apt puts `node` and `npm` in `/usr/bin`, so `npm prefix -g` is `/usr` and the `trafic-agent` binary lands on root's `PATH` — the systemd unit resolves it with `which trafic-agent`, which needed a `/usr/local/bin` symlink before. More importantly, apt-managed Node.js receives security patches through the `unattended-upgrades` that the hardening step configures; an fnm install never did. Drops `/opt/fnm`, `/etc/profile.d/fnm.sh` and the `unzip` dependency ([9a6cec4], [#30])
- **Agent**: `installSystemDeps` also installs `gnupg` and `ca-certificates` — both apt repositories (DDEV and NodeSource) need `gpg --dearmor`, and a minimal Ubuntu image ships with neither ([9a6cec4], [#30])

### Fixed

- **CLI**: Only symlink the agent binary into `/usr/local/bin` when the npm global prefix is not already on root's `PATH`, instead of for every prefix except `/usr/local` ([9a6cec4], [#30])

## [0.1.24] - 2026.09.01

### Changed

- **Agent**: Upgrade `smol-toml` 1.6 → 1.8 ([5097cbe], [#29])
- **CI**: Upgrade GitHub Actions — `actions/checkout` v4 → v7 and `actions/setup-node` v4 → v7, which clears the Node 20 deprecation warning; `codecov/codecov-action` v5 → v7; pin `trufflesecurity/trufflehog` to v3.97.1 instead of tracking `@main` ([5097cbe], [#29])
- **Dev**: Upgrade the toolchain — `vitest` and `@vitest/coverage-v8` 4.1.0-beta.5 → 4.1.11, `vite` 8.0.0-beta.16 → 8.2.2 (both off beta), `oxlint` 1.51 → 1.80, `lint-staged` 16 → 17, `@types/node` 22 → 24 to match `engines.node` ([5097cbe], [#29])
- **Dev**: Replace `@typescript/native-preview` with `typescript` 7.0.2 — the native compiler now ships as a stable TypeScript release, so the dev preview is obsolete. Build and typecheck scripts call `tsc` instead of `tsgo` ([cb4784f], [#29])
- **Dev**: Set `types: ["node"]` in the shared tsconfig — TypeScript 7 no longer includes `@types` packages automatically ([cb4784f], [#29])

## [0.1.23] - 2026.09.01

### Added

- **CLI**: Add `trafic setup` — setup a new server over SSH from any machine with SSH access to it. Bootstraps Node.js 24 via fnm (installing `curl` and `unzip` when missing), installs `@studiometa/trafic-agent`, symlinks its binary into `/usr/local/bin`, then runs `trafic-agent setup` on the server. Supports `--tld`, `--email`, `--agent-version`, `--ssh-users`, `--no-hardening`, `--no-docker`, `--no-ddev` and `--dry-run`. Connects as `root` by default, or prefixes privileged commands with `sudo -n` for any other user ([3c049db], [#28])

### Changed

- **CLI**: `ssh.exec()` accepts an optional timeout — the server setup step uses 45 minutes instead of the 10-minute default, because Docker and DDEV installs are slow ([3c049db], [#28])

## [0.1.22] - 2026.03.05

### Fixed

- **Agent**: Fix auth bypass — switch Traefik from catch-all router (priority=1, ineffective against DDEV project routers) to entry point-level middleware via `static_config.trafic.yaml`; DDEV merges this into `.static_config.yaml` so every request on `http-80`/`http-443` passes through auth ([9c1adf5], [#27])
- **Agent**: Fix `basic_auth` parsing — TOML inline tables (`{username, password}`) were not normalized to `"user:pass"` strings, causing credentials to always fail ([f2ac2bc], [#27])
- **Agent**: Add migration `0008__traefik_entrypoint_middleware` — applies the Traefik config change on existing servers and restarts DDEV ([9c1adf5], [#27])
- **CI**: Run CI checks on `fix/**` branches ([b63e29b], [#27])

## [0.1.21] - 2026.03.05

### Fixed

- **Agent**: Fix `upgrade` loop — use `readlink -f` to resolve the binary symlink and read `package.json` directly for the installed version check ([be2b7b9])
- **Agent**: Fix UFW — allow trafic-agent port 9876 from Docker bridge subnets (`172.16.0.0/12`) so `ddev-router` can reach the forward-auth endpoint; without this auth silently times out ([bc9304e])
- **Agent**: Add migration `0007__ufw_docker_trafic_port` — adds the UFW rule on existing servers ([bc9304e])

## [0.1.20] - 2026.03.05

### Fixed

- **Agent**: Fix `upgrade` infinite loop — verify installed version from `package.json` on disk before re-execing, use `--prefer-online` to bypass npm cache, and guard re-exec with `TRAFIC_UPGRADE_REEXEC=1` env var ([99bc7ba], [#26])

## [0.1.19] - 2026.03.05

### Fixed

- **Agent**: Fix `getDockerGatewayIp()` — inspect `ddev_default` network first (where `ddev-router` actually runs) instead of the default `bridge` network ([ef986b4])
- **Agent**: Add migration `0006__traefik_gateway_ip_fix` — corrects the wrong IP written by migration `0005` on existing servers ([09bbc8a])

## [0.1.18] - 2026.03.05

### Fixed

- **Agent**: Fix Traefik forward-auth config — use Docker bridge gateway IP instead of `host.docker.internal`, which is not available on Linux and caused auth to be silently bypassed ([5e342d9], [#25])
- **Agent**: Add migration `0005__traefik_gateway_ip` — rewrites existing `trafic.yaml` in-place with the correct gateway IP ([a703523], [#25])

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

### Fixed

- **CLI**: Report argument parse errors with a message and the help text. A dash-leading value such as `--trusted-proxy-hops -1` reads as another flag to `parseArgs`, which previously surfaced as a raw `TypeError` and stack trace ([c7d62ed], [#34])

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

[Unreleased]: https://github.com/studiometa/trafic/compare/0.1.28...HEAD
[0.1.28]: https://github.com/studiometa/trafic/compare/0.1.27...0.1.28
[0.1.27]: https://github.com/studiometa/trafic/compare/0.1.26...0.1.27
[0.1.26]: https://github.com/studiometa/trafic/compare/0.1.25...0.1.26
[0.1.25]: https://github.com/studiometa/trafic/compare/0.1.24...0.1.25
[0.1.24]: https://github.com/studiometa/trafic/compare/0.1.23...0.1.24
[0.1.23]: https://github.com/studiometa/trafic/compare/0.1.22...0.1.23
[0.1.22]: https://github.com/studiometa/trafic/compare/0.1.21...0.1.22
[0.1.21]: https://github.com/studiometa/trafic/compare/0.1.20...0.1.21
[0.1.20]: https://github.com/studiometa/trafic/compare/0.1.19...0.1.20
[0.1.19]: https://github.com/studiometa/trafic/compare/0.1.18...0.1.19
[0.1.18]: https://github.com/studiometa/trafic/compare/0.1.17...0.1.18
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
[#25]: https://github.com/studiometa/trafic/pull/25
[#26]: https://github.com/studiometa/trafic/pull/26
[be2b7b9]: https://github.com/studiometa/trafic/commit/be2b7b9
[bc9304e]: https://github.com/studiometa/trafic/commit/bc9304e
[f2ac2bc]: https://github.com/studiometa/trafic/commit/f2ac2bc
[9c1adf5]: https://github.com/studiometa/trafic/commit/9c1adf5
[b63e29b]: https://github.com/studiometa/trafic/commit/b63e29b
[#27]: https://github.com/studiometa/trafic/pull/27
[3c049db]: https://github.com/studiometa/trafic/commit/3c049db
[#28]: https://github.com/studiometa/trafic/pull/28
[5097cbe]: https://github.com/studiometa/trafic/commit/5097cbe
[cb4784f]: https://github.com/studiometa/trafic/commit/cb4784f
[#29]: https://github.com/studiometa/trafic/pull/29
[9a6cec4]: https://github.com/studiometa/trafic/commit/9a6cec4
[#30]: https://github.com/studiometa/trafic/pull/30
[#31]: https://github.com/studiometa/trafic/pull/31
[2f4fef6]: https://github.com/studiometa/trafic/commit/2f4fef6
[#32]: https://github.com/studiometa/trafic/pull/32
[92c72da]: https://github.com/studiometa/trafic/commit/92c72da
[#33]: https://github.com/studiometa/trafic/pull/33
[c7d62ed]: https://github.com/studiometa/trafic/commit/c7d62ed
[#34]: https://github.com/studiometa/trafic/pull/34
[a29913e]: https://github.com/studiometa/trafic/commit/a29913e
[#35]: https://github.com/studiometa/trafic/pull/35
[#31]: https://github.com/studiometa/trafic/pull/31
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
[5e342d9]: https://github.com/studiometa/trafic/commit/5e342d9
[a703523]: https://github.com/studiometa/trafic/commit/a703523
[ef986b4]: https://github.com/studiometa/trafic/commit/ef986b4
[09bbc8a]: https://github.com/studiometa/trafic/commit/09bbc8a
[99bc7ba]: https://github.com/studiometa/trafic/commit/99bc7ba
[0.1.0]: https://github.com/studiometa/trafic/releases/tag/0.1.0

[1012821]: https://github.com/studiometa/trafic/commit/1012821
[f086115]: https://github.com/studiometa/trafic/commit/f086115
[36bca6b]: https://github.com/studiometa/trafic/commit/36bca6b

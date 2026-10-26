### Security

- **Agent**: Fix automatic updates. From 0.1.43, setup and a migration put the Docker entry in `Unattended-Upgrade::Allowed-Origins`, which only accepts `origin:archive` pairs. Each run of `unattended-upgrades` stopped with `Unable to parse Unattended-Upgrade::Allowed-Origins` and installed no update, Ubuntu security updates included. The Docker entry is now in `Unattended-Upgrade::Origins-Pattern`. A migration writes the correct file on existing servers: run `sudo trafic-agent upgrade`

### Added

- **Agent**: `trafic-agent audit` runs `unattended-upgrade --dry-run --verbose`, which installs nothing. The `Update run` check fails when the run cannot parse its config or stops with a Python traceback

### Changed

- **Agent**: Automatic updates also install the updates of Ubuntu's `-updates` pocket, and the minor and patch releases of Node.js from the NodeSource repository. DDEV is still updated only by `trafic-agent upgrade`

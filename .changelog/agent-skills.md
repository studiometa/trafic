### Added

- **Dev**: Add the `trafic-cli` and `trafic-agent` agent skills in `skills/`. Install them with `npx skills add studiometa/trafic` or `gh skill install studiometa/trafic`
- **CLI**: Add the `trafic skill` command. It prints the `trafic-cli` agent skill that matches the installed version
- **Agent**: Add the `trafic-agent skill` command. It prints the `trafic-agent` agent skill that matches the installed version

### Fixed

- **CLI**: `trafic deploy --timeout` also sets the time limit of the rsync of each `--sync` path. Before, a `--sync` always stopped after 10 minutes
- **Agent**: The help and the README of `trafic-agent audit` say to run it with `sudo`. As another user, the firewall and wildcard certificate checks fail

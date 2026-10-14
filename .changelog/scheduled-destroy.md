### Added

- **CLI**: Add the `--delay` option to `trafic destroy`, for example `--delay 48h`. It removes nothing now: the agent records the removal date and removes the project when it is due. With `--backup`, the agent backs up the project before the removal.
- **Agent**: Add the `--delay`, `--cancel` and `--list` options to `trafic-agent destroy`. They schedule a removal, cancel it and list the scheduled removals. The agent keeps the dates in its database.
- **Agent**: The agent service removes the projects whose scheduled removal is due, every `idle_check_interval`. When a removal fails, the agent logs the error and tries again on the next check. The service makes the backups of these removals inside its systemd sandbox, so `[backup] dir` must be inside `/var/backups/trafic`, `/home/ddev` or `/var/lib/trafic`. A backup that cannot write to `[backup] dir` fails with an error that names the sandbox.

### Changed

- **CLI**: `trafic deploy` cancels a removal of the project scheduled with `trafic destroy --delay`. This is the new first step of the deploy, so the deploy fails when `trafic-agent` is not on the `PATH` of the SSH user. Upgrade the agent on the server before you upgrade the CLI.

### Added

- **Agent**: Add the `--backup` option to `trafic-agent destroy`. Before the removal, the agent dumps the database with `ddev export-db` to `db.sql.gz` and archives the upload directories to `files.tar.gz`, in `<backup.dir>/<project>/<timestamp>/`. It starts a stopped project for the backup and stops it again. If the backup fails, nothing is removed and the command fails. `trafic-agent destroy` checks the config as `start` does, and refuses to run when it is not valid.
- **Agent**: Add the `[backup]` config section: `dir` (default `/var/backups/trafic`) and `retain_days` (default `14`). The agent service removes backups older than `retain_days` once an hour.
- **Agent**: Setup creates `/var/backups/trafic` for the `ddev` user and lets the agent service write to it. A migration does the same on existing servers: run `sudo trafic-agent upgrade`.
- **CLI**: Add the `--backup` option to `trafic destroy`. It runs `trafic-agent destroy --backup` on the server. Upgrade the agent on the server before you use it.
- **CLI**: `trafic destroy` reads `--timeout` (default `10m`). Raise it to back up a large project.

### Fixed

- **Agent**: `getProjectInfo` now reads the database type from `ddev describe`. It was always empty.

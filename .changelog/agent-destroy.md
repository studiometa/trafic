### Added

- **Agent**: Add the `trafic-agent destroy <name>` command. It deletes the DDEV project (`ddev delete -Oy`), removes the project directory and deletes the project's rows from the agent database. It refuses a directory outside `projects_dir`.

### Changed

- **CLI**: `trafic destroy` runs `trafic-agent destroy` on the server instead of running `ddev delete` and `rm -rf` itself. The agent finds the project directory from its config, so `destroy` no longer reads `--projects-dir`. Upgrade the agent on the server before you use this CLI version.
- **Agent**: The database waits up to 5 seconds for a lock, so the service and `trafic-agent destroy` can write to it at the same time.

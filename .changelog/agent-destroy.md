### Added

- **Agent**: Add the `trafic-agent destroy <name>` command. It deletes the DDEV project (`ddev delete -Oy`), removes the project directory and deletes the project's rows from the agent database. It refuses a directory outside `projects_dir` (also after it follows symbolic links) or a project directory that is a symbolic link, and refuses to run as root.

### Changed

- **CLI**: `trafic destroy` runs `trafic-agent destroy` on the server instead of running `ddev delete` and `rm -rf` itself. The agent finds the project directory from its config, so `destroy` no longer reads `--projects-dir`. `projects_dir` in `/etc/trafic/config.toml` must be the directory that `trafic deploy --projects-dir` uses (default `~/www`, which is `/home/ddev/www`). If you deploy to another directory, set `projects_dir` before you upgrade, or `trafic destroy` fails. `trafic destroy` must connect as the `ddev` user (the default `--user`), because the agent reads `/etc/trafic/config.toml` and writes to `/var/lib/trafic`. Upgrade the agent on the server before you use this CLI version.
- **Agent**: The database waits up to 5 seconds for a lock, so the service and `trafic-agent destroy` can write to it at the same time.

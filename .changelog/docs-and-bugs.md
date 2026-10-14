### Added

- **Agent**: Add the `--version` and `-v` options to `trafic-agent`. They print the version, as the `version` command does
- **Agent**: A backup of `trafic-agent destroy --backup` that goes over its time limit fails with an error that says it timed out and that `--timeout` raises the limit
- **Agent**: When `trafic-agent destroy` cannot read the config or open the database, the error says to connect as the `ddev` user, and the command exits with code 1 without a stack trace

### Fixed

- **Agent**: `/__health__` returns the agent version. Before, it returned the text `__VERSION__`
- **Agent**: `trafic-agent setup` installs the agent at its own version. Before, it installed the latest version, so `trafic setup --agent-version` did not keep the version it installed
- **Agent**: An `idle_timeout` in `.ddev/config.trafic.yaml` that is shorter than the global `idle_timeout` now stops the project. Before, the idle sweep only looked at the projects idle longer than the global `idle_timeout`
- **Agent**: The agent service removes the access logs older than 30 days, when it starts and then once an hour. Before, the agent database grew without limit
- **CLI**: On a GitHub `pull_request` event, `trafic deploy` takes the branch from `$GITHUB_HEAD_REF`. Before, it took `$GITHUB_REF_NAME`, which is `<number>/merge` there and which git clone cannot use

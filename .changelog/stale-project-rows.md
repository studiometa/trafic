### Fixed

- **Agent**: The agent service deletes the database rows of projects that DDEV no longer lists, when it starts and at each idle sweep. Before, a project removed outside the agent (with `ddev delete` by hand, or with `trafic destroy` before 0.1.50) kept its rows, and the idle sweep ran `ddev describe` on it, which failed, at each check
- **Agent**: When the project directory does not exist, `trafic-agent destroy` says that it deleted the project's rows from the agent database. Before, it printed "nothing to destroy" even when it deleted them

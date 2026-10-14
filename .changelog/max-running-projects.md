### Added

- **Agent**: Add the `max_running_projects` option to limit how many projects run at the same time. Before the waiting page starts a project, the agent stops the running project with the oldest access when the server is at the limit. Projects that the agent is starting count as running, so many starts at the same time stay under the limit. The idle sweep also stops projects until the server is back under the limit, because `trafic deploy` starts projects without the agent. Projects with `idle_timeout: never` are never stopped by this rule. A project that `trafic-agent destroy` is removing is never stopped by this rule or by the idle sweep, so the backup that starts it does not fail, and the waiting page does not start it again. When the removal is killed, the agent sets the project back to `running` once the `trafic-agent destroy` process is gone, so the idle sweep can stop it. Unset or `0` means no limit

### Fixed

- **Agent**: The exported `listProjects` function reads the `raw` array of `ddev list -j` and no longer blocks the event loop. Before, it always returned an empty list
- **Agent**: A start that the agent service did not finish because it restarted no longer leaves the project on the waiting page: the service sets the project back to `running` when it starts again

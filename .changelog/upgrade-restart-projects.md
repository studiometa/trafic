### Changed

- **Agent**: When the DDEV version changes, `trafic-agent upgrade` restarts the running DDEV projects, so that they use the new DDEV images at once. It downloads the images first, then restarts the projects one at a time, before it restarts the service. Stopped and paused projects stay stopped. A failed restart is only a warning. Before, a running project kept its old containers, for example an old PHP version, until it stopped

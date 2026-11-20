### Fixed

- **Agent**: Migration `0025__purge_trafic_volume_files` finds the old Trafic files with `find` instead of `ls`. With `ls`, a glob that matched nothing made the command fail, and the migration removed nothing, as on a server where only `static_config.trafic.yaml` was left in the volume

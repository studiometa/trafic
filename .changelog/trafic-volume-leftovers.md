### Fixed

- **Agent**: The router no longer loads the old `trafic-*` middlewares and routers after the rename. DDEV copies `~/.ddev/traefik` into the `ddev-global-cache` volume but never removes a file there, so the Trafic files that migration `0024__rename_from_trafic` removed from `~/.ddev/traefik` stayed in the volume, and Traefik kept loading them next to the `ppreview-*` ones. Migration `0025__purge_trafic_volume_files` removes them from the volume and restarts `ddev-router`

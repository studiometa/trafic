# Add the custom Traefik configurations
sudo mkdir -p /home/ddev/.config/ddev/traefik/config/
sudo cp $TRAFIC_ROOT_DIR/config/traefik/static_config.ddev-server.yaml /home/ddev/.config/ddev/traefik/
sudo chown ddev:ddev /home/ddev/.config/ddev/traefik/static_config.ddev-server.yaml
sudo cp $TRAFIC_ROOT_DIR/config/traefik/default_config.yaml /home/ddev/.config/ddev/traefik/config/
sudo chown ddev:ddev /home/ddev/.config/ddev/traefik/config/default_config.yaml

DDEV_PROJECT_TO_START=$(sudo su - ddev -c "ddev ls --json-output --active-only | jq -r '.raw[0].name'")
sudo su - ddev -c "ddev poweroff"
sudo su - ddev -c "ddev start $DDEV_PROJECT_TO_START"

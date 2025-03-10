# Configure DDEV for ddev user
# We need to use custom ports for Mailpit as Cloudflare has only
# a limited set of open ports on its router.
# @see https://developers.cloudflare.com/fundamentals/reference/network-ports/
sudo su - ddev -c "
	ddev config global \
		--project-tld=${DDEV_PROJECT_TLD:-ddev.site} \
		--omit-containers=ddev-ssh-agent \
		--mailpit-http-port=2052 \
		--mailpit-https-port=2053 \
		--router-bind-all-interfaces
" || sudo mkdir -p /home/ddev/.config/ddev

# Add the custom Traefik configurations
sudo mkdir -p /home/ddev/.config/ddev/traefik/config/
sudo cp $TRAFIC_ROOT_DIR/config/traefik/static_config.ddev-server.yaml /home/ddev/.config/ddev/traefik/
sudo chown ddev:ddev /home/ddev/.config/ddev/traefik/static_config.ddev-server.yaml
sudo cp $TRAFIC_ROOT_DIR/config/traefik/default_config.yaml /home/ddev/.config/ddev/traefik/config/
sudo chown ddev:ddev /home/ddev/.config/ddev/traefik/config/default_config.yaml

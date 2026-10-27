### Changed

- **Agent**: Mailpit and xhgui (DDEV's tool ports, 8025, 8026, 8142 and 8143 by default) now answer from outside the server, behind forward auth: an allowed IP, basic auth or a token. Before, the `DOCKER-USER` rules dropped them, and they were reachable only through an SSH tunnel. The firewall opens a tool port only when its entry point carries `trafic-auth@file` in the Traefik static config that Trafic writes

### Security

- **Agent**: The `DOCKER-USER` rules now close every port that Docker publishes and that has no forward auth, to traffic from outside Docker's networks. Only the router's HTTP and HTTPS ports and DDEV's tool ports stay open. Before, the rules closed only the tool ports, so a port that a DDEV add-on publishes with `HTTP_EXPOSE` or `HTTPS_EXPOSE` (for example Elasticsearch on 9200 and 9201) answered the internet without forward auth. Migration `0022__docker_user_default_deny` installs the new script and applies it at once. It also removes the rules of the old script, so a server where an operator added ports to `PORTS` in `/usr/local/sbin/trafic-docker-firewall` by hand gets the new script, without stale rules

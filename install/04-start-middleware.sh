cd $DDEV_SERVER_ROOT/middleware
EXTERNAL_IP=$(curl --silent https://ipv4.icanhazip.com/)
docker compose up -d --always-recreate-deps --build --env SSH_HOST=$EXTERNAL_IP
cd $DDEV_SERVER_ROOT

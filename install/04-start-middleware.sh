cd $DDEV_SERVER_ROOT/middleware
docker compose up -d --always-recreate-deps --build
cd $DDEV_SERVER_ROOT

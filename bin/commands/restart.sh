cd $TRAFIC_ROOT_DIR/middleware
docker compose down
docker compose up -d --always-recreate-deps --build
cd -

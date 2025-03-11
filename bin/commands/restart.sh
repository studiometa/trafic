cd $TRAFIC_ROOT_DIR/middleware
docker compose down --rmi all --remove-orphans
docker compose up -d --always-recreate-deps --build
cd -

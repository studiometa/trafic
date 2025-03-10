cd $TRAFFIC_ROOT_DIR

LAST_UPDATED_AT=$(git log -1 --format=%cd --date=unix)

git pull

for file in $TRAFFIC_ROOT_DIR/migrations/*.sh; do
	filename=$(basename "$file")
	migrate_at="${filename%.sh}"

	if [ $migrate_at -gt $last_updated_at ]; then
		echo "Running migration for $migrate_at"
		source $file
	fi
done

cd -

source ./restart.sh

cd $TRAFFIC_ROOT_DIR

LAST_UPDATED_AT=$(git log -1 --format=%cd --date=unix)

git pull

for FILE in $TRAFFIC_ROOT_DIR/migrations/*.sh; do
	FILENAME=$(basename "$FILE")
	MIGRATE_AT="${FILENAME%.sh}"
	echo "$FILE"
	echo "$FILENAME"
	echo "$MIGRATE_AT"
	if [[ $MIGRATE_AT -gt $LAST_UPDATED_AT ]]
	then
		echo "Running migration for $MIGRATE_AT..."
		source $FILE
	fi
done

cd -

source ./restart.sh

export DDEV_PROJECT_TLD=${DDEV_PROJECT_TLD:-ikko.dev}

for installer in $TRAFIC_ROOT_DIR/install/*.sh; do echo "
running $installer...
" && source $installer; done

export DDEV_PROJECT_TLD=${DDEV_PROJECT_TLD:-ikko.dev}

sudo apt update -y
sudo apt upgrade -y
sudo apt install -y curl git zip zsh wget vim

for installer in $TRAFIC_ROOT_DIR/install/*.sh; do echo "
running $installer...
" && source $installer; done

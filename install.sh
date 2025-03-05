set -e

cd "$(dirname "$0")"
export DDEV_SERVER_ROOT=$(pwd)

sudo apt update -y
sudo apt upgrade -y
sudo apt install -y curl git zip zsh wget vim

for installer in ./install/*.sh; do source $installer; done

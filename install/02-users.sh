# Change shell for ubuntu user
sudo chsh -s $(which zsh) ubuntu
sudo usermod -aG docker ubuntu
sudo cp $DDEV_SERVER_ROOT/config/zshrc /home/ubuntu/.zshrc && sudo chown ubuntu:ubuntu /home/ubuntu/.zshrc
sudo cp $DDEV_SERVER_ROOT/config/gitconfig /home/ubuntu/.gitconfig && sudo chown ubuntu:ubuntu /home/ubuntu/.gitconfig
sudo cp $DDEV_SERVER_ROOT/config/vimrc /home/ubuntu/.vimrc && sudo chown ubuntu:ubuntu /home/ubuntu/.vimrc
sudo su - ubuntu -c "zsh /home/ubuntu/.zshrc"

# Create ddev user
sudo useradd --create-home ddev
sudo usermod -aG docker ddev
sudo chsh -s $(which zsh) ddev
sudo echo "ddev ALL= NOPASSWD:SETENV: /usr/bin/mkcert, /usr/bin/ddev, /usr/bin/hostname" | sudo tee /etc/sudoers.d/100-ddev > /dev/null
sudo cp $DDEV_SERVER_ROOT/config/zshrc /home/ddev/.zshrc && sudo chown ddev:ddev /home/ddev/.zshrc
sudo cp $DDEV_SERVER_ROOT/config/gitconfig /home/ddev/.gitconfig && sudo chown ddev:ddev /home/ddev/.gitconfig
sudo cp $DDEV_SERVER_ROOT/config/vimrc /home/ddev/.vimrc && sudo chown ddev:ddev /home/ddev/.vimrc
sudo su - ddev -c "zsh /home/ddev/.zshrc"

# Generate an SSH key for the ddev user
sudo su - ddev -c "ssh-keygen -t ed25519 -a 32 -f ~/.ssh/id_ed25519 -N ''"

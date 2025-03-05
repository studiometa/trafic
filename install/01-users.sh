# Change shell for current user
sudo chsh -s $(which zsh) $(whoami)
sudo cp $DDEV_SERVER_ROOT/config/zshrc ~/.zshrc
sudo su - $(whoami) -c "zsh $HOME/.zshrc"
sudo cp $DDEV_SERVER_ROOT/config/vimrc ~/.vimrc

# Create ddev user
sudo useradd --create-home ddev
sudo usermod -aG docker ddev
sudo chsh -s $(which zsh) ddev
sudo echo "ddev ALL= NOPASSWD:SETENV: /usr/bin/mkcert, /usr/bin/systemctl, /usr/bin/ddev, /usr/bin/hostname" | sudo tee /etc/sudoers.d/100-ddev > /dev/null
sudo cp $DDEV_SERVER_ROOT/config/zshrc /home/ddev/.zshrc && sudo chown ddev:ddev /home/ddev/.zshrc
sudo cp $DDEV_SERVER_ROOT/config/gitconfig /home/ddev/.gitconfig && sudo chown ddev:ddev /home/ddev/.gitconfig
sudo cp $DDEV_SERVER_ROOT/config/vimrc /home/ddev/.vimrc && sudo chown ddev:ddev /home/ddev/.vimrc
sudo su - ddev -c "zsh /home/ddev/.zshrc"

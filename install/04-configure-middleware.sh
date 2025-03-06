# Generate SSH key to allow middleware to SSH into the server
sudo ssh-keygen -t ed25519 -a 32 -f $DDEV_SERVER_ROOT/middleware/ssh_key -N ''

sudo mkdir -p /home/ddev/.ssh
echo "# ddev-server
$(cat $DDEV_SERVER_ROOT/middleware/ssh_key.pub)
" | sudo tee -a /home/ddev/.ssh/authorized_keys2

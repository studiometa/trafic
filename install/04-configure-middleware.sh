# Generate SSH key to allow middleware to SSH into the server
sudo ssh-keygen -t ed25519 -a 32 -f $TRAFIC_ROOT_DIR/middleware/ssh_key -N ''

# Allow access to the server
sudo mkdir -p /home/ddev/.ssh
echo "# trafic
$(cat $TRAFIC_ROOT_DIR/middleware/ssh_key.pub)
" | sudo tee -a /home/ddev/.ssh/authorized_keys2

# Condigure server external IP
EXTERNAL_IP=$(curl --silent https://ipv4.icanhazip.com/)
echo "SSH_HOST=$EXTERNAL_IP" | sudo tee $TRAFIC_ROOT_DIR/middleware/.env.local

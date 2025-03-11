# Allow SSH access to ddev user
sudo cat /home/ubuntu/.ssh/authorized_keys | sudo tee -a /home/ddev/.ssh/authorized_keys
sudo chown ddev:ddev /home/ddev/.ssh/authorized_keys

# Fix DDEV config path
sudo chown -R ddev:ddev /home/ddev/.config/ddev
sudo su - ddev -c "rsync -ahvp /home/ddev/.ddev/ /home/ddev/.config/ddev/"
sudo su - ddev -c "rm -r /home/ddev/.ddev"

sudo apt-get install -y --force-yes unattended-upgrades

echo '''
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
''' | sudo tee /etc/apt/apt.conf.d/10periodic

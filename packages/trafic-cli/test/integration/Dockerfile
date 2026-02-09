# Ubuntu 24.04 with SSH for integration testing
FROM ubuntu:24.04

# Install SSH server and rsync
RUN apt-get update && \
    apt-get install -y openssh-server rsync sudo && \
    rm -rf /var/lib/apt/lists/*

# Create test user with sudo access
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Setup SSH directory
RUN mkdir /var/run/sshd && \
    mkdir -p /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chown -R testuser:testuser /home/testuser/.ssh

# Generate host keys
RUN ssh-keygen -A

# Disable password auth, only allow key-based
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config

# The authorized_keys will be mounted at runtime
EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]

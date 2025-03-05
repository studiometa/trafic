FROM ubuntu:24.10

RUN apt update -y && apt install -y sudo
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-ubuntu
USER ubuntu
WORKDIR /home/ubuntu/.local/share/ddev-server
COPY . .
RUN bash install.sh

SHELL ["/bin/zsh"]
CMD ["/bin/zsh"]

# 🚦 Trafic

A DDEV add-on to configure a server for preview environments with auth and scale to zero features.

## Installation

On a fresh installation of Ubuntu 24.x with the `ubuntu` user having sudo access: 

1. Clone the repository
2. Run the `./bin/trafic install` script

The install script will : 

- Install Docker, DDEV and required dependencies
- Create a `ddev` user with access to ddev and docker 
- Configure DDEV with a given custom project TLD 
- Add custom Traefik configurations to DDEV
- Start the Traefik middleware for auth and scale-to-zero features

## To-do

- [ ] update architecture doc
- [ ] setup unattended-upgrade

## Architecture

This project is made of the following:

- a DDEV project serving as a Traefik errors middleware
- a DDEV project serving as a Traefik forward auth middleware
- a DDEV `watcher` command to start and stop projects based on their access
- custom configurations for Traefik to enable advanced logging and add the auth middleware to the default config

The flow of a request is as follow:

```mermaid
flowchart TD
  request --> ddev-router
  ddev-router --> auth-middleware
  auth-middleware --> |ok| traefik
  auth-middleware --> | not ok | 401(401 unauthorized)
  traefik --> |project is on| ddev-web
  traefik --> |project is off| errors-middleware
  errors-middleware --> |project exists| request
  errors-middleware --> |project does not exist| redirect(redirect studiometa.fr)
```

Two CRON jobs with the `ddev watcher start` and `ddev watcher stop` must be configured.

```mermaid
flowchart TD
  ddev-watcher --> |start| ddev-watcher-start
  ddev-watcher --> |stop| ddev-watcher-stop
  ddev-watcher-start --> |project is visited and off| start-project
  ddev-watcher-start --> |project is visited and on| do-nothing
  ddev-watcher-stop --> |project is not visited and off| do-nothing
  ddev-watcher-stop --> |project is not visited and on| stop-project
```

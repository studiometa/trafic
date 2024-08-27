# ddev-error-pages

Service développé pour le middleware Error de Traefik pour afficher des pages d'erreurs personnalisées. 

Ce projet est déployé et utilisé sur le serveur ddev hébergeant les environnements de préproduction des projets de Studio Meta. Il permet d'afficher un message d'erreur personnalisé quand un visiteur tente d'accéder à un environnement qui a été arrêté faute d'activité. 

## Utilisation

Clonez le projet sur un serveur avec ddev configuré : 

```sh
git clone gitlab@gitlab.studiometa.dev:tools/ddev-error-pages.git
```

Démarrez le service avec `docker-compose` : 

```sh
cd ddev-error-pages/
docker-compose up -d
```

Ajoutez un fichier de configuration `custom-error-pages.yaml` pour Traefik dans le dossier `~/.ddev/traefik/config` :  

```yaml
# custom-error-pages.yaml
http:
  routers:
    custom-error-pages-web-80-http:
      rule: HostRegexp(`{host:.+}`)
      service: "custom-error-pages-web-80-http"
      tls: false
      entrypoints:
        - http-80
    
    custom-error-pages-web-80-https:
      rule: HostRegexp(`{host:.+}`)
      service: "custom-error-pages-web-80-https"
      tls: true
      entrypoints:
        - http-443

  middlewares:
    custom-error-pages-middleware:
      errors:
        status:
          - "400-599"
        service: custom-error-pages-web-80-http
        query: "/?status={status}"

  services:
    custom-error-pages-web-80-http:
      loadbalancer:
        servers:
          - url: http://custom-error-pages:80

    custom-error-pages-web-80-https:
      loadbalancer:
        servers:
          - url: http://custom-error-pages:80
```

Et ajoutez le middleware `custom-error-pages-middleware` aux points d'entrée des ports `80` et `443` de la configuration statique de Traefik dans le fichier `~/.ddev/traefik/static_config.yaml` :

```yaml
# ...
entryPoints:
  # ...

  http-443:
    address: ":443"
    http:
      middlewares:
        - custom-error-pages-middleware@file

  http-80:
    address: ":80"
    http:
      middlewares:
        - custom-error-pages-middleware@file

  # ...
```

Enfin, configurez une tâche CRON pour dumper régulièrement la liste des projets ddev dans un fichier `ddev-projects.json` à la racine de ce dépôt :  

```sh
# Dump projects information every minute so it is available to other tools
* * * * * /usr/bin/ddev ls -j | /usr/bin/jq .raw > /path/to/repository/ddev-projects.json 2>&1
```

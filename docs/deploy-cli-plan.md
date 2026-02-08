# Plan : CLI de déploiement `trafic deploy` (côté CI)

## Contexte

### Flow actuel

Les projets Studio Meta se déploient via `studiometa/gitlab-ci` → `config/deploy/ddev/.ddev.yml` :

```
CI runner (stages: install → quality → build → deploy)
│
│  install_dependencies   npm install / composer install
│  code_quality           eslint, prettier, phpcs, phpstan
│  build                  npm run build → artifacts dist/
│                         composer install --no-dev → artifacts vendor/
│
│  deploy (SSH)
│  ├── git clone/pull le repo sur le serveur
│  ├── ddev start (si conteneur pas running)
│  ├── rsync artifacts (dist/, vendor/) vers le serveur
│  ├── ddev exec "composer install --no-dev" (dans le conteneur)
│  └── cleanup node_modules
```

Tout le build lourd (npm, webpack/vite, composer) se fait sur le **runner CI**. Le serveur DDEV ne fait que recevoir les fichiers et exécuter les commandes PHP légères dans le conteneur Docker.

### Problèmes

1. **~160 lignes de bash inline dans du YAML** : Le `.ddev.yml` génère des scripts bash à la volée, les pipe dans SSH. Impossible à tester, débugger, ou maintenir.
2. **Pas de visibilité** : L'agent Trafic ne sait pas qu'un déploiement est en cours → peut `stop-idle` un projet pendant un deploy.
3. **Pas de rollback** : Si un deploy échoue à mi-chemin, l'état est incohérent.
4. **Duplication** : preprod, preview, et stop dupliquent la logique SSH.
5. **Trop de variables** : 15+ variables CI (`DDEV_SSH_HOST`, `DDEV_PROJECT_NAME`, `DDEV_DEPLOY_SCRIPT`, `DDEV_HOOK_BEFORE`, `DDEV_HOOK_AFTER_CREATE`, ...).

## Proposition : `trafic deploy` côté CI

### Architecture

Le CLI `trafic deploy` tourne sur le **runner CI** (pas sur le serveur). Il orchestre le déploiement via SSH/rsync. C'est un remplacement du bash inline de `.ddev.yml` par un outil TypeScript testable.

```
CI runner                                    Serveur DDEV
────────                                     ────────────
npm install + build (stages précédents)

trafic deploy (stage deploy)
  ├── SSH: git clone/pull                →   ~/www/<project>
  ├── SSH: ddev start (si nécessaire)    →   conteneur Docker up
  ├── rsync: dist/, vendor/              →   ~/www/<project>/...
  ├── SSH: ddev exec "composer i"        →   dans le conteneur
  └── SSH: ddev describe                 →   affiche les infos
```

### Pourquoi un CLI plutôt que du bash

| Aspect        | Bash inline (actuel)           | CLI trafic                             |
| ------------- | ------------------------------ | -------------------------------------- |
| Tests         | ❌ Impossible                  | ✅ Vitest                              |
| Debug         | ❌ Logs CI opaques             | ✅ Étapes numérotées, logs structurés  |
| Maintenance   | ❌ 160 lignes YAML/bash        | ✅ TypeScript modulaire                |
| Réutilisation | ❌ Copier/coller entre projets | ✅ `npx @studiometa/trafic-cli deploy` |
| Rollback      | ❌ Aucun                       | ✅ Possible (git checkout + redeploy)  |
| Validation    | ❌ Fail à l'exécution          | ✅ Validation des args au démarrage    |
| État agent    | ❌ Agent ignorant du deploy    | ✅ Peut notifier l'agent via HTTP      |

### Installation dans la CI

Le CLI est publié sur npm public (comme `@studiometa/productive-cli`) :

```yaml
deploy_preprod:
  script:
    - npx @studiometa/trafic-cli deploy ...
```

Simple, versionné, cacheable via `npm ci`.

### Interface CLI

```bash
trafic deploy [options]

Options:
  --host <host>           Serveur SSH (requis)
  --user <user>           Utilisateur SSH (défaut: ddev)
  --port <port>           Port SSH (défaut: 22)
  --ssh-options <opts>    Options SSH supplémentaires (ex: "-J jump@host")

  --repo <url>            URL du repo git (défaut: $CI_REPOSITORY_URL)
  --branch <branch>       Branche à déployer (défaut: $CI_COMMIT_REF_NAME)
  --name <name>           Nom du projet DDEV (défaut: slug du repo)

  --preview <iid>         Numéro de MR → crée preview-<iid>--<name>
  --sync <paths>          Chemins à rsync (séparés par des virgules)
  --script <cmd>          Script à exécuter dans le conteneur DDEV
  --before-script <cmd>   Script à exécuter avant le build (sur le serveur, hors conteneur)
  --after-script <cmd>    Script à exécuter après le build (sur le serveur, hors conteneur)

  --projects-dir <path>   Répertoire des projets (défaut: ~/www)
  --no-start              Ne pas démarrer le conteneur DDEV
  --timeout <duration>    Timeout (défaut: 10m)

trafic destroy [options]

Options:
  --host, --user, --port, --ssh-options  (même que deploy)
  --name <name>           Nom du projet DDEV à supprimer
  --preview <iid>         Numéro de MR (calcule le nom)
```

### Exemples d'utilisation

```bash
# Déploiement preprod classique (WordPress)
trafic deploy \
  --host preprod.ovh.studiometa.fr \
  --name wordpress-project \
  --sync "web/wp-content/themes/studiometa/dist/" \
  --script "composer i --no-interaction --no-progress --prefer-dist"

# Déploiement preview depuis une MR
trafic deploy \
  --host preprod.ovh.studiometa.fr \
  --name wordpress-project \
  --preview 42 \
  --sync "web/wp-content/themes/studiometa/dist/" \
  --script "composer i --no-interaction --no-progress --prefer-dist"
# → Crée l'environnement preview-42--wordpress-project

# Suppression d'un environnement preview
trafic destroy \
  --host preprod.ovh.studiometa.fr \
  --name wordpress-project \
  --preview 42

# Déploiement Laravel (sans rsync, tout dans le conteneur)
trafic deploy \
  --host preprod.ovh.studiometa.fr \
  --name mon-app-laravel \
  --script "composer i --no-dev && php artisan migrate --force"

# Déploiement avec jump host (Unistra)
trafic deploy \
  --host 192.168.0.47 \
  --ssh-options "-J studiometa@185.155.93.167" \
  --name unistra \
  --sync "dist/" \
  --script "composer i --no-dev"
```

### Étapes internes de `trafic deploy`

```typescript
async function deploy(options: DeployOptions): Promise<void> {
  const ssh = createSSHClient(options);
  const projectName = options.preview
    ? `preview-${options.preview}--${options.name}`
    : options.name;
  const projectDir = `${options.projectsDir}/${projectName}`;

  // 1. Clone ou pull
  step('Mise à jour du code');
  const exists = await ssh.test(`test -d ${projectDir}`);
  if (exists) {
    await ssh.exec(`
      cd ${projectDir}
      git remote set-url origin ${options.repo}
      git fetch --depth=1 origin ${options.branch}
      git checkout FETCH_HEAD
    `);
  } else {
    await ssh.exec(`
      git clone --depth 1 --branch ${options.branch} ${options.repo} ${projectDir}
    `);
    // Config DDEV locale pour le premier déploiement
    await ssh.exec(`
      cd ${projectDir}
      echo 'name: ${projectName}' > .ddev/config.local.yaml
      echo 'override_config: true' >> .ddev/config.local.yaml
    `);
  }

  // 2. Démarrer DDEV si nécessaire
  step('Démarrage du conteneur DDEV');
  const status = await ssh.exec(`cd ${projectDir} && ddev describe -j | jq -r .raw.status`);
  if (status.trim() !== 'running') {
    await ssh.exec(`cd ${projectDir} && ddev start`);
  }

  // 3. Before script (hors conteneur)
  if (options.beforeScript) {
    step('Before script');
    await ssh.exec(`cd ${projectDir} && ${options.beforeScript}`);
  }

  // 4. Rsync des artifacts buildés
  if (options.sync?.length) {
    step('Synchronisation des fichiers');
    for (const path of options.sync) {
      await rsync(path, ssh, projectDir);
    }
  }

  // 5. Script dans le conteneur DDEV
  if (options.script) {
    step('Exécution du script de build');
    await ssh.exec(`cd ${projectDir} && ddev exec "${options.script}"`);
  }

  // 6. After script (hors conteneur)
  if (options.afterScript) {
    step('After script');
    await ssh.exec(`cd ${projectDir} && ${options.afterScript}`);
  }

  // 7. Afficher les infos
  step('Vérification');
  await ssh.exec(`cd ${projectDir} && ddev describe`);

  success(`Déployé sur https://${projectName}.${options.tld ?? 'ddev.site'}`);
}
```

### Intégration avec l'agent Trafic (optionnel, phase 2)

Le CLI pourrait notifier l'agent HTTP qu'un déploiement est en cours :

```bash
# Au début du deploy
curl -s http://localhost:9876/__deploy__/start?project=<name>

# À la fin
curl -s http://localhost:9876/__deploy__/done?project=<name>
```

Ça permettrait à l'agent de :

- Ne pas `stop-idle` le projet pendant le deploy
- Afficher une page "déploiement en cours" au lieu d'une erreur
- Logger les déploiements dans la DB SQLite

Mais **ce n'est pas bloquant pour la v1** du CLI. Le deploy actuel fonctionne sans.

## Structure du code

### Où mettre le CLI deploy

Le CLI `trafic` existe déjà dans `agent/cli/` mais il est couplé à l'agent Nitro (setup, status, logs sont des commandes serveur). Le CLI de déploiement est un outil **CI** distinct.

**Option retenue** : un nouveau workspace `packages/trafic-cli/` dans le monorepo (convention `productive-tools`).

```
trafic/
├── packages/
│   ├── trafic-agent/           # @studiometa/trafic-agent (serveur) — existant
│   │   ├── cli/                # CLI serveur (setup, status, logs)
│   │   ├── routes/
│   │   └── ...
│   └── trafic-cli/             # @studiometa/trafic-cli (CI) — nouveau
│       ├── src/
│       │   ├── cli.ts          # Entry point CLI
│       │   ├── index.ts        # Library entry point
│       │   ├── commands/
│       │   │   ├── deploy.ts   # trafic deploy
│       │   │   └── destroy.ts  # trafic destroy
│       │   ├── ssh.ts          # Wrapper SSH (exec, test, rsync)
│       │   ├── steps.ts        # Logger avec étapes numérotées
│       │   └── types.ts        # Types partagés
│       ├── test/
│       │   ├── deploy.test.ts
│       │   ├── destroy.test.ts
│       │   └── ssh.test.ts     # Tests avec mocks SSH
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── examples/
│   ├── gitlab-ci.yml
│   └── github-actions.yml
└── package.json                # Root workspace
```

### package.json du CLI

```json
{
  "name": "@studiometa/trafic-cli",
  "version": "1.0.0",
  "description": "CLI to deploy projects to DDEV servers - preview environments from CI",
  "keywords": ["ci", "cli", "ddev", "deploy", "preview"],
  "license": "MIT",
  "author": "Studio Meta",
  "repository": {
    "type": "git",
    "url": "https://github.com/studiometa/trafic",
    "directory": "packages/trafic-cli"
  },
  "bin": {
    "trafic": "./dist/cli.js"
  },
  "files": ["dist"],
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build && tsc --emitDeclarationOnly",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ci": "vitest run --coverage",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0",
    "vite": "^6.0.0",
    "vitest": "^4.0.0"
  },
  "engines": {
    "node": ">=24.0.0"
  }
}
```

### Dépendances minimales

Le CLI n'a **aucune dépendance runtime**. Tout est natif Node :

- **`node:child_process`** : Exécution de `ssh` et `rsync`
- **`node:util`** : `parseArgs` pour le parsing CLI (Node >= 18.3)
- **`node:console`** : Logs

Pas de SDK SSH JavaScript, pas de citty, pas de consola — on utilise directement les APIs natives Node et les binaires `ssh`/`rsync` du système (toujours disponibles sur les runners CI).

## Config `studiometa/gitlab-ci`

### Nouveau fichier : `config/deploy/trafic/preprod.yml`

```yaml
include:
  - local: config/global/.stages.yml
  - local: config/global/.default-rules.yml

variables:
  TRAFIC_SSH_HOST: preprod.ovh.studiometa.fr
  TRAFIC_SSH_USER: ddev
  TRAFIC_SSH_OPTIONS: ''
  TRAFIC_PROJECT_NAME: $CI_PROJECT_PATH_SLUG
  TRAFIC_DEPLOY_SCRIPT: ''
  TRAFIC_DEPLOY_SYNC: ''
  TRAFIC_DEPLOY_BEFORE_SCRIPT: ''
  TRAFIC_DEPLOY_AFTER_SCRIPT: ''

deploy_preprod:
  stage: deploy
  before_script:
    - eval $(ssh-agent -s)
    - chmod 600 "$SSH_PRIVATE_KEY"
    - ssh-add "$SSH_PRIVATE_KEY"
  script:
    - >-
      npx @studiometa/trafic-cli deploy
      --host $TRAFIC_SSH_HOST
      --user $TRAFIC_SSH_USER
      ${TRAFIC_SSH_OPTIONS:+--ssh-options "$TRAFIC_SSH_OPTIONS"}
      --repo $CI_REPOSITORY_URL
      --branch $CI_COMMIT_REF_NAME
      --name $TRAFIC_PROJECT_NAME
      ${TRAFIC_DEPLOY_SYNC:+--sync "$TRAFIC_DEPLOY_SYNC"}
      ${TRAFIC_DEPLOY_SCRIPT:+--script "$TRAFIC_DEPLOY_SCRIPT"}
      ${TRAFIC_DEPLOY_BEFORE_SCRIPT:+--before-script "$TRAFIC_DEPLOY_BEFORE_SCRIPT"}
      ${TRAFIC_DEPLOY_AFTER_SCRIPT:+--after-script "$TRAFIC_DEPLOY_AFTER_SCRIPT"}
  after_script:
    - ssh-agent -k 2>/dev/null || true
  rules:
    - !reference [.default_rules, branch_rules_develop]
```

### Nouveau fichier : `config/deploy/trafic/preview.yml`

```yaml
include:
  - local: config/deploy/trafic/preprod.yml

deploy_preview:
  extends: deploy_preprod
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    on_stop: deploy_preview_stop
  script:
    - >-
      npx @studiometa/trafic-cli deploy
      --host $TRAFIC_SSH_HOST
      --user $TRAFIC_SSH_USER
      ${TRAFIC_SSH_OPTIONS:+--ssh-options "$TRAFIC_SSH_OPTIONS"}
      --repo $CI_REPOSITORY_URL
      --branch $CI_COMMIT_REF_NAME
      --name $TRAFIC_PROJECT_NAME
      --preview $CI_MERGE_REQUEST_IID
      ${TRAFIC_DEPLOY_SYNC:+--sync "$TRAFIC_DEPLOY_SYNC"}
      ${TRAFIC_DEPLOY_SCRIPT:+--script "$TRAFIC_DEPLOY_SCRIPT"}
  rules:
    - !reference [.default_rules, wip_rules]
    - !reference [.default_rules, deploy_preview_rules]

deploy_preview_stop:
  stage: deploy
  environment:
    name: review/$CI_COMMIT_REF_SLUG
    action: stop
  before_script:
    - eval $(ssh-agent -s)
    - chmod 600 "$SSH_PRIVATE_KEY"
    - ssh-add "$SSH_PRIVATE_KEY"
  script:
    - >-
      npx @studiometa/trafic-cli destroy
      --host $TRAFIC_SSH_HOST
      --user $TRAFIC_SSH_USER
      ${TRAFIC_SSH_OPTIONS:+--ssh-options "$TRAFIC_SSH_OPTIONS"}
      --name $TRAFIC_PROJECT_NAME
      --preview $CI_MERGE_REQUEST_IID
  after_script:
    - ssh-agent -k 2>/dev/null || true
  allow_failure: true
  rules:
    - if: $CI_MERGE_REQUEST_ID && $CI_MERGE_REQUEST_LABELS =~ /.*deploy::preview.*/
      when: manual
```

## Utilisation dans un projet

### WordPress (avant → après)

**Avant** :

```yaml
variables:
  DDEV_PROJECT_NAME: wordpress-project
  DDEV_DEPLOY_SCRIPT: |
    composer i --no-interaction --no-progress --prefer-dist
  DDEV_DEPLOY_PATHS: |
    web/wp-content/themes/studiometa/dist/

include:
  - config/deploy/ddev/preprod.yml
  - config/deploy/ddev/preview.yml
```

**Après** :

```yaml
variables:
  TRAFIC_PROJECT_NAME: wordpress-project
  TRAFIC_DEPLOY_SCRIPT: 'composer i --no-interaction --no-progress --prefer-dist'
  TRAFIC_DEPLOY_SYNC: 'web/wp-content/themes/studiometa/dist/'

include:
  - config/deploy/trafic/preprod.yml
  - config/deploy/trafic/preview.yml
```

### Laravel :

```yaml
variables:
  TRAFIC_PROJECT_NAME: mon-app
  TRAFIC_DEPLOY_SCRIPT: 'composer i --no-dev && php artisan migrate --force'

include:
  - config/deploy/trafic/preprod.yml
```

### Avec jump host (Unistra) :

```yaml
variables:
  TRAFIC_SSH_HOST: 192.168.0.47
  TRAFIC_SSH_OPTIONS: '-J studiometa@185.155.93.167'
  TRAFIC_PROJECT_NAME: unistra
  TRAFIC_DEPLOY_SYNC: 'dist/'
  TRAFIC_DEPLOY_SCRIPT: 'composer i --no-dev'
```

## Plan d'implémentation

### Phase 1 : CLI minimal (`packages/trafic-cli/`)

1. Créer le workspace `packages/trafic-cli/` (convention `productive-tools`)
2. Implémenter `ssh.ts` : wrapper autour de `ssh` et `rsync` (exec, test, rsync) — zéro deps runtime, Node natif
3. Implémenter `deploy.ts` : les 7 étapes (clone → start → sync → exec → verify)
4. Implémenter `destroy.ts` : `ddev delete` + `rm -rf`
5. Tests avec mocks SSH (vitest + coverage v8)
6. Build avec Vite lib mode → `dist/cli.js` + `dist/index.js` + types

### Phase 2 : Publication et intégration CI

1. Publier `@studiometa/trafic-cli` sur npm public (GitHub Actions publish workflow)
2. Créer `config/deploy/trafic/` dans `studiometa/gitlab-ci`
3. Documenter dans le README + exemples GitLab CI / GitHub Actions

### Phase 3 : Migration des projets

1. Commencer par un projet test (ex: wordpress-project sur preprod)
2. Valider le flow complet (preprod + preview + destroy)
3. Migrer les autres projets progressivement

### Phase 4 (optionnelle) : Intégration agent

1. Ajouter une route `/__deploy__/{start,done}` à l'agent
2. Le CLI notifie l'agent au début/fin du deploy via SSH + curl
3. L'agent marque le projet comme "deploying" → pas de stop-idle

## Questions ouvertes

1. **Publication npm** : Registry GitLab privé (`@studiometa/trafic`) ou juste `npx` avec l'URL git ?
2. **Nommage** : `trafic deploy` ou `trafic-deploy` (package séparé) ?
3. **Config locale** : Supporter un fichier `.trafic.yml` dans chaque projet pour éviter les variables CI ?
4. **node_modules cleanup** : Le système actuel supprime `node_modules` après deploy (économie disque). Garder ce comportement ?
5. **DDEV config.local.yaml** : Quels champs écrire au premier deploy ? (name, ports mailhog, mutagen disabled, override_config)

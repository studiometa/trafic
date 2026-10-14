# Plan : Rendre Trafic open-source

> Historical plan (February 2026). It does not describe the current code. See the package READMEs.

## Analyse : Qu'est-ce qui est spécifique à Studio Meta ?

### Code agent (quasi-générique)

Le cœur de l'agent est **déjà générique**. Il repose sur DDEV, Traefik et SQLite — pas sur des services Studio Meta.

| Fichier                   | Studio Meta spécifique | Détail                                                |
| ------------------------- | ---------------------- | ----------------------------------------------------- |
| `utils/auth.ts`           | ❌ Non                 | IP matching, basic auth, tokens, glob rules           |
| `utils/config.ts`         | ❌ Non                 | Parsing TOML, durées, valeurs par défaut              |
| `utils/ddev.ts`           | ❌ Non                 | Parsing project_list.yaml, hostname index             |
| `utils/db.ts`             | ❌ Non                 | SQLite queries, idle projects                         |
| `utils/glob.ts`           | ❌ Non                 | Pattern matching                                      |
| `routes/__auth__.ts`      | ❌ Non                 | Forward auth Traefik                                  |
| `routes/[...path].ts`     | ❌ Non                 | Errors middleware, page d'attente                     |
| `routes/__status__/`      | ❌ Non                 | Polling status                                        |
| `tasks/stop-idle.ts`      | ❌ Non                 | Scale-to-zero                                         |
| `plugins/config.ts`       | ❌ Non                 | c12 config loader                                     |
| `plugins/watcher.ts`      | ⚠️ 1 ligne             | `'example.com'` en fallback TLD (devrait être en config) |
| `plugins/database.ts`     | ❌ Non                 | Schema init                                           |
| `cli/setup.ts`            | ⚠️ 1 ligne             | `'example.com'` comme exemple de TLD                     |
| `cli/setup/ddev.ts`       | ❌ Non                 | Installation DDEV générique                           |
| `cli/setup/docker.ts`     | ❌ Non                 | Installation Docker générique                         |
| `cli/setup/node.ts`       | ❌ Non                 | Installation Node via fnm                             |
| `cli/setup/traefik.ts`    | ❌ Non                 | Config Traefik pour forward auth                      |
| `cli/setup/user.ts`       | ❌ Non                 | Création user ddev                                    |
| `cli/setup/swap.ts`       | ❌ Non                 | Config swap                                           |
| `cli/setup/monitoring.ts` | ❌ Non                 | Setup monitoring (optionnel)                          |

### Seules parties spécifiques Studio Meta

1. **`.gitlab-ci.yml`** : Jobs de déploiement avec les hosts Studio Meta (example.com, etc.)
2. **`README.md`** : Tableau des serveurs Studio Meta
3. **`config/example.config.toml`** : Exemple avec `tiptoe` (cosmétique)
4. **`plugins/watcher.ts` L.27** : Fallback `example.com` au lieu de lire la config
5. **Configs serveur** : `config/gitconfig`, `config/vimrc`, `config/zshrc` — spécifiques aux serveurs SM

**Conclusion** : Le code est déjà à 95% générique. Les 5% restants sont du hardcoding de TLD et des fichiers d'infra.

## Vision : Trafic comme outil open-source

### Positionnement

**Trafic** : Un outil CLI pour gérer des preview environments DDEV sur n'importe quel serveur Linux.

```
npx trafic setup     # Configure un serveur (Docker, DDEV, Traefik, agent)
npx trafic deploy    # Déploie un projet depuis la CI
npx trafic destroy   # Supprime un environnement preview
```

### Comparable à

| Outil       | Cible                 | Infra         | Trafic se compare par...                                      |
| ----------- | --------------------- | ------------- | ------------------------------------------------------------- |
| **Coolify** | Apps Docker           | VPS self-host | Plus léger, spécialisé PHP/WordPress via DDEV                 |
| **Kamal**   | Apps Docker           | VPS, cloud    | Même philosophie CLI, mais pour DDEV au lieu de Docker direct |
| **uncloud** | Containers            | EU servers    | Similaire mais vendor-neutral, DDEV-native                    |
| **Vercel**  | JS/Static             | Cloud         | Preview environments, mais pour PHP/WordPress                 |
| **SST**     | Serverless AWS        | AWS           | Pas le même monde                                             |
| **DDEV**    | Environnements de dev | Local         | Trafic = DDEV en production/staging sur un VPS                |

### Pitch

> **DDEV preview environments on any Linux server.**
>
> Trafic turns a VPS into a preview server for your web projects. It handles authentication, scale-to-zero, auto-start, and deployments from CI — all powered by DDEV and Traefik.
>
> ```bash
> # Setup a server
> npx trafic setup --tld=previews.example.com
>
> # Deploy from CI
> npx trafic deploy --host=server.example.com --name=my-app --branch=main
>
> # Your app is live at https://my-app.previews.example.com
> ```

## Conventions de développement

Suivre les conventions établies dans `studiometa/productive-tools` :

### Tooling

| Outil        | Choix                                                            |
| ------------ | ---------------------------------------------------------------- |
| Node         | >= 24 (`.nvmrc` avec `24`)                                       |
| Package mgr  | npm avec workspaces                                              |
| Build        | Vite (lib mode) + `tsc --emitDeclarationOnly`                    |
| Test         | Vitest (avec coverage v8, JUnit reporter pour CI)                |
| Lint         | oxlint                                                           |
| Format       | oxfmt                                                            |
| Type check   | TypeScript strict                                                |
| Pre-commit   | husky + lint-staged (oxlint --fix + oxfmt --write)               |
| CI           | GitHub Actions (lint, test, publish)                             |
| Dependencies | Renovate bot                                                     |
| Security     | npm audit + semgrep (secrets detection)                          |
| Coverage     | Codecov                                                          |
| Versioning   | Scripts root `npm run version:{patch,minor,major}` synced across |
| Tags         | Sans prefix `v` (ex: `0.1.0`, pas `v0.1.0`)                      |
| Releases     | Automatiques via GitHub Actions au push d'un tag                 |

### Conventions code

- **ESM** (`"type": "module"`)
- **`node:` prefix** pour les builtins (`node:fs`, `node:path`, etc.)
- **TypeScript strict** partout
- **Pas de dépendances inutiles** — utiliser les APIs natives Node quand possible
- **Exports propres** avec `exports` field dans package.json
- **`publishConfig.access: "public"`** pour les packages npm

### Conventions Git & Changelog

- **Commit messages** : English, verb-first (`Add...`, `Fix...`, `Update...`)
- **Co-authorship** : `Co-authored-by: Claude <claude@anthropic.com>` quand applicable
- **CHANGELOG unique** à la racine pour tout le monorepo
- Prefix entries par package : `**Agent**: ...`, `**CLI**: ...`
- Références commits `[hash]` et PRs `[#N]` avec liens en bas du fichier
- **Branches** : `main` (default) + `develop` + feature branches

### Fichiers repo

```
.github/
├── workflows/
│   ├── ci.yml              # Lint + Test + Coverage (on push/PR)
│   ├── publish.yml         # Publish to npm (on tag push)
│   └── security.yml        # npm audit + semgrep (weekly + on push)
├── CODEOWNERS
.nvmrc                      # "24"
.husky/pre-commit           # lint-staged + semgrep secrets
CHANGELOG.md                # Keep a Changelog, single file
CLAUDE.md                   # Instructions for AI agents
CONTRIBUTING.md             # Dev setup, code style, PR process
LICENSE                     # MIT
README.md                   # User-facing docs
renovate.json               # Dependency management
```

## Structure monorepo

```
trafic/
├── packages/
│   ├── trafic-agent/                  # @studiometa/trafic-agent
│   │   ├── routes/                    # Routes Nitro (auth, errors, status)
│   │   ├── plugins/                   # Plugins Nitro (config, watcher, db)
│   │   ├── tasks/                     # Tasks planifiées (stop-idle)
│   │   ├── utils/                     # Utilitaires (auth, config, ddev, db, glob)
│   │   ├── cli/                       # CLI serveur (setup, status, logs)
│   │   ├── templates/                 # Pages HTML (wait, error)
│   │   ├── test/
│   │   ├── nitro.config.ts
│   │   ├── vite.config.ts            # Pour le build du CLI setup
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── trafic-cli/                    # @studiometa/trafic-cli
│       ├── src/
│       │   ├── cli.ts                 # Entry point CLI
│       │   ├── index.ts               # Library entry point
│       │   ├── commands/
│       │   │   ├── deploy.ts
│       │   │   └── destroy.ts
│       │   ├── ssh.ts                 # Wrapper SSH (exec, test, rsync)
│       │   ├── steps.ts              # Logger avec étapes numérotées
│       │   └── types.ts
│       ├── test/
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── examples/
│   ├── gitlab-ci.yml
│   ├── github-actions.yml
│   └── config.toml
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── publish.yml
│   │   └── security.yml
│   └── CODEOWNERS
├── .nvmrc                             # "24"
├── CHANGELOG.md
├── CLAUDE.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── package.json                       # Root workspace
└── renovate.json
```

### Packages npm

| Package                    | Description                          | Utilisé par              |
| -------------------------- | ------------------------------------ | ------------------------ |
| `@studiometa/trafic-cli`   | CLI de déploiement (deploy, destroy) | Runner CI                |
| `@studiometa/trafic-agent` | Agent serveur (auth, scale-to-zero)  | Serveur DDEV (via setup) |

Le CLI `trafic-cli` est l'outil principal utilisé dans les pipelines CI. Il est installé via `npx @studiometa/trafic-cli deploy ...`.

L'agent `trafic-agent` est installé sur le serveur par `trafic setup`. Il tourne en tant que service systemd.

### Root package.json

```json
{
  "name": "@studiometa/trafic",
  "version": "1.0.0",
  "private": true,
  "description": "DDEV preview environments on any Linux server",
  "keywords": ["ddev", "deploy", "preview", "scale-to-zero", "traefik", "vps"],
  "license": "MIT",
  "author": "Studio Meta",
  "repository": {
    "type": "git",
    "url": "https://github.com/studiometa/trafic"
  },
  "workspaces": ["packages/*"],
  "type": "module",
  "scripts": {
    "dev": "npm run dev --workspaces",
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "test:ci": "npm run test:ci --workspaces --if-present",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check .",
    "typecheck": "npm run typecheck --workspaces",
    "clean": "rm -rf packages/*/dist packages/*/node_modules node_modules",
    "version:patch": "npm version --include-workspace-root --workspaces --no-git-tag-version patch",
    "version:minor": "npm version --include-workspace-root --workspaces --no-git-tag-version minor",
    "version:major": "npm version --include-workspace-root --workspaces --no-git-tag-version major",
    "prepare": "husky"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^4.0.0",
    "husky": "^9.0.0",
    "lint-staged": "^16.0.0",
    "oxfmt": "^0.28.0",
    "oxlint": "^1.43.0",
    "typescript": "^5.9.0",
    "vite": "^6.0.0",
    "vitest": "^4.0.0"
  },
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["oxlint --fix", "oxfmt --write"],
    "*.{json,md,yml,yaml}": ["oxfmt --write"]
  },
  "engines": {
    "node": ">=24.0.0"
  }
}
```

### CLI package.json (`packages/trafic-cli/package.json`)

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

### GitHub Actions CI

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run build --workspace=@studiometa/trafic-agent
      - run: npm run typecheck

  test:
    name: Test & Coverage
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run build --workspace=@studiometa/trafic-agent
      - run: npm run test:ci
      - uses: codecov/codecov-action@v5
        if: always()
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./packages/trafic-cli/coverage/lcov.info,./packages/trafic-agent/coverage/lcov.info
          fail_ci_if_error: false
```

```yaml
# .github/workflows/publish.yml
name: Publish

on:
  push:
    tags:
      - '*.*.*'

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm run typecheck
      - run: npm run test:ci

  publish:
    name: Publish to npm
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
          registry-url: https://registry.npmjs.org/
      - run: npm ci
      - run: npm run build
      - name: Determine npm tag
        run: |
          VERSION=${GITHUB_REF_NAME}
          NPM_TAG='latest'
          IS_PRERELEASE=false
          if [[ $VERSION =~ (alpha|beta|rc) ]]; then
            NPM_TAG='next'
            IS_PRERELEASE=true
          fi
          echo "NPM_TAG=$NPM_TAG" >> $GITHUB_ENV
          echo "IS_PRERELEASE=$IS_PRERELEASE" >> $GITHUB_ENV
      - name: Publish @studiometa/trafic-cli
        run: npm publish --provenance --access public --tag ${{ env.NPM_TAG }}
        working-directory: packages/trafic-cli
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: Publish @studiometa/trafic-agent
        run: npm publish --provenance --access public --tag ${{ env.NPM_TAG }}
        working-directory: packages/trafic-agent
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: ncipollo/release-action@v1
        with:
          tag: ${{ github.ref_name }}
          name: ${{ github.ref_name }}
          body: |
            See [CHANGELOG.md](https://github.com/${{ github.repository }}/blob/${{ github.ref_name }}/CHANGELOG.md) for details.
          draft: false
          prerelease: ${{ env.IS_PRERELEASE }}
```

## Modifications nécessaires

### 1. Supprimer le hardcoding

```diff
# plugins/watcher.ts
- const tld = process.env.DDEV_TLD ?? 'example.com';
+ const tld = config.tld;
```

Ajouter `tld` comme champ obligatoire dans la config TOML :

```toml
# Required: TLD for DDEV projects
tld = "previews.example.com"
```

### 2. Restructurer en monorepo npm

Déplacer `agent/` vers `packages/trafic-agent/`, créer `packages/trafic-cli/`.

### 3. Migrer le build vers Vite

L'agent utilise actuellement Nitro build (`nitro build`). Le CLI deploy sera buildé avec Vite (lib mode) comme dans `productive-tools` :

```typescript
// packages/trafic-cli/vite.config.ts
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: {
        index: './src/index.ts',
        cli: './src/cli.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    },
    target: 'node24',
    minify: false,
    sourcemap: true,
  },
});
```

### 4. Documentation multi-CI

Fournir des exemples pour :

- **GitLab CI** (cas Studio Meta, principal)
- **GitHub Actions** (le plus demandé en open-source)
- **Generic** (n'importe quel CI avec SSH)

### 5. Supprimer les fichiers SM-spécifiques

- `config/gitconfig`, `config/vimrc`, `config/zshrc`, `config/npmrc` → supprimés
- `.gitlab-ci.yml` → déplacé dans `examples/`
- `bin/migrate-v1-to-v2.sh` → supprimé (migration interne)
- `bin/tsc-to-codequality.sh`, `bin/oxfmt-to-codequality.sh` → supprimés (spécifique GitLab)

### 6. Ajouter les fichiers standard open-source

- `LICENSE` (MIT)
- `CLAUDE.md` (instructions AI, English)
- `CONTRIBUTING.md` (dev setup, code style, PR process, English)
- `.github/workflows/ci.yml` + `publish.yml` + `security.yml`
- `.github/CODEOWNERS`
- `renovate.json`
- `.nvmrc` → `24`
- `.husky/pre-commit` → lint-staged + semgrep

## Nom et branding

### Garder "Trafic" ?

✅ **Oui** :

- Court, mémorable
- Fait référence au trafic web / routing
- Pas de conflit npm évident (`trafic` est libre)
- Référence au film de Jacques Tati 🚗 (français, c'est bien)

**Verdict** : Garder `trafic`. Scope `@studiometa/` pour les packages npm.

## Plan de transition

### Phase 1 : Nettoyage du repo actuel

1. Supprimer le hardcoding `example.com`
2. Ajouter `tld` dans la config
3. Supprimer les fichiers SM-spécifiques

### Phase 2 : Implémenter le CLI deploy

(cf. `docs/deploy-cli-plan.md`)

Utiliser Vite lib mode pour le build, pas de deps runtime (juste `node:child_process` pour SSH/rsync).

### Phase 3 : Restructurer en monorepo

1. `packages/trafic-agent/` — agent Nitro
2. `packages/trafic-cli/` — CLI CI (deploy, destroy)
3. Root workspace avec scripts version sync
4. GitHub Actions CI/CD

### Phase 4 : Publication open-source

1. Créer le repo GitHub `github.com/studiometa/trafic`
2. Publier `@studiometa/trafic-cli` et `@studiometa/trafic-agent` sur npm
3. Documentation : README + CLAUDE.md + CONTRIBUTING.md + examples/
4. `LICENSE` MIT
5. Renovate bot, Codecov, CODEOWNERS

### Phase 5 : Studio Meta utilise la version publique

1. Les serveurs SM installent `@studiometa/trafic-agent` depuis npm
2. `studiometa/gitlab-ci` utilise `npx @studiometa/trafic-cli deploy` dans ses configs
3. Le repo privé `tools/trafic` devient un wrapper avec les configs SM (`.gitlab-ci.yml`, hosts, etc.)

## Ce qui rend Trafic unique

Aucun outil n'offre cette combinaison :

1. **DDEV-native** : Pas besoin de Dockerfiles custom, utilise l'écosystème DDEV (PHP, WordPress, Laravel, Drupal, etc.)
2. **Scale-to-zero** : Les projets inactifs sont stoppés automatiquement → économie de RAM
3. **Auth intégrée** : Forward auth Traefik avec IP whitelist, tokens, basic auth, rules par hostname
4. **Preview environments** : Créer/détruire des envs depuis la CI comme Vercel, mais pour PHP
5. **Un seul CLI** : `setup` (serveur) + `deploy` (CI) + `status`/`logs` (ops)
6. **Config TOML** : Simple, lisible, pas de YAML infernal
7. **Zéro vendor lock-in** : Tourne sur n'importe quel VPS Linux avec SSH

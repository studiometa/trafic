#!/usr/bin/env node

import { parseArgs } from "node:util";
import { deploy } from "./commands/deploy.js";
import { destroy } from "./commands/destroy.js";
import { setup } from "./commands/setup.js";
import { error } from "./steps.js";
import type { DeployOptions, DestroyOptions, SetupOptions } from "./types.js";

declare const __VERSION__: string;

const HELP = `
  🚦 trafic — DDEV preview environments from CI

  Usage:
    trafic setup [options]     Setup a new DDEV server over SSH
    trafic deploy [options]    Deploy a project to a DDEV server
    trafic destroy [options]   Destroy a DDEV project

  Common options:
    --host <host>              SSH host (required)
    --user <user>              SSH user (default: ddev, root for setup)
    --port <port>              SSH port (default: 22)
    --ssh-options <opts>       Extra SSH options (e.g. "-J jump@host")

  Setup options:
    --tld <domain>             TLD for DDEV projects (required)
    --email <email>            Email for Let's Encrypt certificates
    --agent-version <version>  Agent version to install (default: latest)
    --ssh-users <users>        SSH users to allow, comma-separated (default: ddev)
                               --user is always added, so hardening cannot lock you out
    --no-hardening             Skip server hardening
    --no-docker                Skip Docker installation
    --no-ddev                  Skip DDEV installation
    --dry-run                  Print the remote commands without running them

  Deploy options:
    --repo <url>               Git repo URL (default: $CI_REPOSITORY_URL or $GITHUB_SERVER_URL/$GITHUB_REPOSITORY)
    --branch <branch>          Branch to deploy (default: $CI_COMMIT_REF_NAME or $GITHUB_REF_NAME)
    --name <name>              DDEV project name (required)
    --preview <iid>            MR/PR number → creates preview-<iid>--<name>
    --sync <paths>             Paths to rsync, comma-separated
    --script <cmd>             Script to run inside the DDEV container
    --before-script <cmd>      Script to run before deploy (on server)
    --after-script <cmd>       Script to run after deploy (on server)
    --projects-dir <path>      Projects directory (default: ~/www)
    --no-start                 Skip starting the DDEV container
    --timeout <duration>       Timeout (default: 10m)

  Destroy options:
    --name <name>              DDEV project name (required)
    --preview <iid>            MR/PR number (computes the name)
    --projects-dir <path>      Projects directory (default: ~/www)

  Other:
    --version                  Show version
    --help                     Show this help

  Examples:
    trafic setup --host server.example.com --tld previews.example.com
    trafic setup --host server.example.com --tld previews.example.com --email admin@example.com
    trafic deploy --host server.example.com --name my-app --branch main
    trafic deploy --host server.example.com --name my-app --preview 42 --sync "dist/"
    trafic destroy --host server.example.com --name my-app --preview 42
`;

/**
 * Detect the git repo URL from CI environment variables.
 */
function detectRepo(): string | undefined {
  // GitLab CI
  if (process.env.CI_REPOSITORY_URL) {
    return process.env.CI_REPOSITORY_URL;
  }

  // GitHub Actions
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) {
    return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}.git`;
  }

  return undefined;
}

/**
 * Detect the git branch from CI environment variables.
 */
function detectBranch(): string | undefined {
  // GitLab CI
  if (process.env.CI_COMMIT_REF_NAME) {
    return process.env.CI_COMMIT_REF_NAME;
  }

  // GitHub Actions (refs/heads/main → main)
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(__VERSION__);
    process.exit(0);
  }

  // Parse arguments (skip the command name)
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      host: { type: "string" },
      user: { type: "string" },
      port: { type: "string", default: "22" },
      "ssh-options": { type: "string", default: "" },
      tld: { type: "string" },
      email: { type: "string" },
      "agent-version": { type: "string", default: "latest" },
      "ssh-users": { type: "string" },
      "no-hardening": { type: "boolean", default: false },
      "no-docker": { type: "boolean", default: false },
      "no-ddev": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string" },
      branch: { type: "string" },
      name: { type: "string" },
      preview: { type: "string" },
      sync: { type: "string" },
      script: { type: "string" },
      "before-script": { type: "string" },
      "after-script": { type: "string" },
      "projects-dir": { type: "string", default: "~/www" },
      "no-start": { type: "boolean", default: false },
      timeout: { type: "string", default: "10m" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (values.version) {
    console.log(__VERSION__);
    process.exit(0);
  }

  // Validate common required options
  if (!values.host) {
    error("Missing required option: --host");
    process.exit(1);
  }

  const sshBase = {
    host: values.host,
    // Setup runs privileged commands, deploy and destroy run as the DDEV user
    user: values.user ?? (command === "setup" ? "root" : "ddev"),
    port: Number.parseInt(values.port!, 10),
    sshOptions: values["ssh-options"]!,
  };

  if (command !== "setup" && !values.name) {
    error("Missing required option: --name");
    process.exit(1);
  }

  switch (command) {
    case "setup": {
      if (!values.tld) {
        error("Missing required option: --tld");
        process.exit(1);
      }

      const setupOptions: SetupOptions = {
        ...sshBase,
        tld: values.tld,
        email: values.email,
        agentVersion: values["agent-version"]!,
        noHardening: values["no-hardening"]!,
        noDocker: values["no-docker"]!,
        noDdev: values["no-ddev"]!,
        sshUsers: values["ssh-users"],
        dryRun: values["dry-run"]!,
      };

      setup(setupOptions).catch((err: Error) => {
        error(`Setup failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case "deploy": {
      const repo = values.repo ?? detectRepo();
      const branch = values.branch ?? detectBranch();

      if (!repo) {
        error(
          "Missing --repo and could not detect from CI environment ($CI_REPOSITORY_URL or $GITHUB_SERVER_URL/$GITHUB_REPOSITORY)",
        );
        process.exit(1);
      }

      if (!branch) {
        error(
          "Missing --branch and could not detect from CI environment ($CI_COMMIT_REF_NAME or $GITHUB_REF_NAME)",
        );
        process.exit(1);
      }

      const deployOptions: DeployOptions = {
        ...sshBase,
        repo,
        branch,
        name: values.name!,
        preview: values.preview,
        sync: values.sync,
        script: values.script,
        beforeScript: values["before-script"],
        afterScript: values["after-script"],
        projectsDir: values["projects-dir"]!,
        noStart: values["no-start"]!,
        timeout: values.timeout!,
      };

      deploy(deployOptions).catch((err: Error) => {
        error(`Deploy failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case "destroy": {
      const destroyOptions: DestroyOptions = {
        ...sshBase,
        name: values.name!,
        preview: values.preview,
        projectsDir: values["projects-dir"]!,
      };

      destroy(destroyOptions).catch((err: Error) => {
        error(`Destroy failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    default:
      error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();

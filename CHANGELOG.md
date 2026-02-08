# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **CLI**: `trafic deploy` command — 7-step DDEV deployment orchestration
- **CLI**: `trafic destroy` command — delete DDEV project and remove directory
- **CLI**: SSH wrapper with exec, test, and rsync over native `node:child_process`
- **CLI**: Auto-detection of repo URL and branch from GitLab CI and GitHub Actions
- **CLI**: Preview environment support with `--preview <iid>` flag
- **CLI**: Step-based logger with colored output for CI readability
- GitHub Actions CI and publish workflows
- GitLab CI and GitHub Actions deployment examples
- Agent TOML configuration example

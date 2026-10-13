### Changed

- **Dev**: Replace direct edits of `CHANGELOG.md` with `.changelog/` fragments checked on pull requests by `weareikko/changelog`, and release on each merge into `main` from the `Release` workflow, which computes the version from the fragments, folds them into `CHANGELOG.md`, tags, creates the GitHub release and publishes to npm

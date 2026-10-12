### Changed

- **Dev**: Replace direct edits of `CHANGELOG.md` with `.changelog/` fragments checked on pull requests by `weareikko/changelog`, and release from the `Release` workflow, which bumps the version, folds the fragments into `CHANGELOG.md`, tags, publishes to npm and creates the GitHub release with the changelog section as its body

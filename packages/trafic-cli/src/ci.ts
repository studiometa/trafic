/**
 * Detect the git repo URL from CI environment variables.
 */
export function detectRepo(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // GitLab CI
  if (env.CI_REPOSITORY_URL) {
    return env.CI_REPOSITORY_URL;
  }

  // GitHub Actions
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}.git`;
  }

  return undefined;
}

/**
 * Detect the git branch from CI environment variables.
 *
 * GitHub sets GITHUB_HEAD_REF on pull_request events only. There,
 * GITHUB_REF_NAME is "<number>/merge", which git clone cannot use.
 */
export function detectBranch(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // GitLab CI
  if (env.CI_COMMIT_REF_NAME) {
    return env.CI_COMMIT_REF_NAME;
  }

  // GitHub Actions, pull_request events
  if (env.GITHUB_HEAD_REF) {
    return env.GITHUB_HEAD_REF;
  }

  // GitHub Actions (refs/heads/main → main)
  if (env.GITHUB_REF_NAME) {
    return env.GITHUB_REF_NAME;
  }

  return undefined;
}

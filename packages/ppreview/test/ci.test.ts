import { describe, it, expect } from "vitest";
import { detectBranch, detectRepo } from "../src/ci.js";

describe("detectRepo", () => {
  it("returns the GitLab repository URL", () => {
    expect(
      detectRepo({ CI_REPOSITORY_URL: "https://gitlab.example.com/a/b.git" }),
    ).toBe("https://gitlab.example.com/a/b.git");
  });

  it("builds the GitHub repository URL", () => {
    expect(
      detectRepo({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "a/b",
      }),
    ).toBe("https://github.com/a/b.git");
  });

  it("returns undefined outside CI", () => {
    expect(detectRepo({})).toBeUndefined();
  });
});

describe("detectBranch", () => {
  it("returns the GitLab branch", () => {
    expect(detectBranch({ CI_COMMIT_REF_NAME: "feature/x" })).toBe("feature/x");
  });

  it("returns the head branch on a GitHub pull_request event", () => {
    expect(
      detectBranch({
        GITHUB_HEAD_REF: "feature/x",
        GITHUB_REF_NAME: "42/merge",
      }),
    ).toBe("feature/x");
  });

  it("returns the ref name on other GitHub events", () => {
    // GitHub sets GITHUB_HEAD_REF to an empty string outside pull_request events
    expect(detectBranch({ GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "main" })).toBe(
      "main",
    );
  });

  it("returns undefined outside CI", () => {
    expect(detectBranch({})).toBeUndefined();
  });
});

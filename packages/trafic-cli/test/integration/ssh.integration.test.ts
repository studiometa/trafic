/**
 * Integration tests for SSH operations
 *
 * Uses Docker to run an Ubuntu 24.04 container with SSH.
 * Works locally and in CI (GitHub Actions).
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { exec, test, rsync } from "../../src/ssh.js";
import type { SSHOptions } from "../../src/types.js";

// SSH key path passed from run.js
const sshKeyPath = process.env.TRAFIC_TEST_SSH_KEY;

// SSH options for Docker container
const sshOptions: SSHOptions = {
  host: "localhost",
  user: "testuser",
  port: 2222,
  sshOptions: [
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    sshKeyPath ? `-i ${sshKeyPath}` : "",
  ]
    .filter(Boolean)
    .join(" "),
};

describe("SSH Integration Tests", () => {
  describe("exec", () => {
    it("executes a simple command", async () => {
      const result = await exec(sshOptions, "echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("executes command with arguments", async () => {
      const result = await exec(sshOptions, "uname -s");
      expect(result.stdout.trim()).toBe("Linux");
    });

    it("handles command with pipes", async () => {
      const result = await exec(sshOptions, "echo 'a b c' | wc -w");
      expect(result.stdout.trim()).toBe("3");
    });

    it("returns multiline output", async () => {
      const result = await exec(sshOptions, "echo -e 'line1\\nline2\\nline3'");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("handles environment variables", async () => {
      const result = await exec(sshOptions, "echo $HOME");
      expect(result.stdout.trim()).toBe("/home/testuser");
    });

    it("throws on command failure", async () => {
      await expect(exec(sshOptions, "exit 1")).rejects.toThrow();
    });

    it("throws on non-existent command", async () => {
      await expect(
        exec(sshOptions, "nonexistentcommand12345"),
      ).rejects.toThrow();
    });
  });

  describe("test", () => {
    it("returns true for existing directory", async () => {
      const result = await test(sshOptions, "test -d /tmp");
      expect(result).toBe(true);
    });

    it("returns false for non-existing directory", async () => {
      const result = await test(sshOptions, "test -d /nonexistent");
      expect(result).toBe(false);
    });

    it("returns true for existing file", async () => {
      const result = await test(sshOptions, "test -f /etc/passwd");
      expect(result).toBe(true);
    });

    it("returns false for non-existing file", async () => {
      const result = await test(sshOptions, "test -f /nonexistent/file");
      expect(result).toBe(false);
    });
  });

  describe("rsync", () => {
    const testDir = "/tmp/trafic-test-rsync";

    beforeAll(async () => {
      // Create test directory on remote
      await exec(sshOptions, `mkdir -p ${testDir}`);
    });

    afterAll(async () => {
      // Cleanup test directory
      await exec(sshOptions, `rm -rf ${testDir}`);
    });

    it("syncs a local file to remote", async () => {
      // Create a temp local directory with a file
      const localDir = "/tmp/trafic-test-local-file";
      execSync(
        `mkdir -p ${localDir} && echo "test content" > ${localDir}/test.txt`,
      );

      try {
        await rsync(localDir, `${testDir}/file-test`, sshOptions);

        // Verify file exists on remote
        const result = await exec(
          sshOptions,
          `cat ${testDir}/file-test/test.txt`,
        );
        expect(result.stdout.trim()).toBe("test content");
      } finally {
        execSync(`rm -rf ${localDir}`);
      }
    });

    it("syncs a directory to remote", async () => {
      // Create a temp local directory with files
      const localDir = "/tmp/trafic-test-dir";
      execSync(
        `mkdir -p ${localDir} && echo "file1" > ${localDir}/a.txt && echo "file2" > ${localDir}/b.txt`,
      );

      try {
        await rsync(`${localDir}/`, `${testDir}/subdir`, sshOptions);

        // Verify files exist on remote
        const resultA = await exec(sshOptions, `cat ${testDir}/subdir/a.txt`);
        const resultB = await exec(sshOptions, `cat ${testDir}/subdir/b.txt`);
        expect(resultA.stdout.trim()).toBe("file1");
        expect(resultB.stdout.trim()).toBe("file2");
      } finally {
        execSync(`rm -rf ${localDir}`);
      }
    });
  });
});

import type { SshIo } from "../../src/ssh.js";
import type { ExecResult } from "../../src/ssh.js";

export interface FakeSshIo extends SshIo {
  /** Every remote command, in order. */
  commands: string[];
  /** The options passed alongside each command, in order. */
  execOptions: ({ log?: string } | undefined)[];
  /** Every rsync, as [localPath, remotePath]. */
  syncs: [string, string][];
  /** Every condition a command tested for, in order. */
  tested: string[];
}

export interface FakeSshIoOptions {
  /** Whether the tested condition holds. Drives clone vs fetch. */
  exists?: boolean;
  /** Per-command control for when a single boolean is not enough. */
  tests?: (command: string) => boolean;
  /**
   * Command mapped to the stdout it should return. An exact match wins over
   * a substring one, so a test can answer one precise command without
   * accidentally answering a longer command that contains it.
   */
  output?: Record<string, string>;
  /** Substring of a command that should fail. */
  fails?: string[];
  /** Precise control for when a substring would match too much. */
  failsWhen?: (command: string) => boolean;
  /** stdout for every rsync, used to drive deletion reporting. */
  rsyncStdout?: string;
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

/**
 * A SshIo that records what a deploy asked for and answers from a script.
 *
 * Injected rather than mocked so the deploy's real control flow runs: the
 * clone-versus-fetch decision, the ordering of the steps, and the pure
 * helpers that summarise rsync output.
 */
export function createFakeSshIo(
  options: FakeSshIoOptions = {},
): FakeSshIo {
  const {
    exists = true,
    tests,
    output = {},
    fails = [],
    failsWhen = () => false,
    rsyncStdout = "",
  } = options;

  const commands: string[] = [];
  const execOptions: ({ log?: string } | undefined)[] = [];
  const syncs: [string, string][] = [];
  const tested: string[] = [];

  return {
    commands,
    execOptions,
    syncs,
    tested,

    exec: ((_options, command, opts) => {
      commands.push(command);
      execOptions.push(opts);

      if (fails.some((needle) => command.includes(needle)) || failsWhen(command)) {
        return Promise.reject(new Error(`Command failed: ${command}`));
      }

      if (command in output) {
        return Promise.resolve(ok(output[command]));
      }

      const matched = Object.entries(output).find(([needle]) =>
        command.includes(needle),
      );

      return Promise.resolve(ok(matched?.[1] ?? ""));
    }) as SshIo["exec"],

    test: ((_options, command) => {
      tested.push(command);
      return Promise.resolve(tests ? tests(command) : exists);
    }) as SshIo["test"],

    rsync: ((localPath: string, remotePath: string) => {
      syncs.push([localPath, remotePath]);
      return Promise.resolve(ok(rsyncStdout));
    }) as SshIo["rsync"],
  };
}

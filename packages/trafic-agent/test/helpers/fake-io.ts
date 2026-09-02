import { vi } from "vitest";
import type { SetupIo } from "../../src/setup/io.js";

/**
 * A recording SetupIo for tests.
 *
 * Every setup function takes a SetupIo, so a test drives it with this
 * instead of mocking modules: pass it in, then assert on what was run and
 * written.
 */
export interface FakeIo extends SetupIo {
  /** Commands passed to exec, in order. */
  commands: string[];
  /** Files written, by path. */
  writes: Map<string, string>;
  /** Content written to a path, or "" when it was never written. */
  written(path: string): string;
  /** Whether any command contains the given fragment. */
  ran(fragment: string): boolean;
}

export interface FakeIoOptions {
  /** Output per command, matched by substring. */
  output?: Record<string, string>;
  /**
   * Command fragments that exit non-zero.
   *
   * exec throws for these, execSilent returns "". Modelling that difference
   * is the point: a probe rewritten from execSilent to exec looks fine until
   * the command actually fails on a real server.
   */
  fails?: string[];
  /** Commands reported as present on the PATH. */
  present?: string[];
  /** Paths reported as existing. */
  files?: Record<string, string>;
  /** Environment seen by the setup functions. */
  env?: Record<string, string | undefined>;
}

export function createFakeIo(options: FakeIoOptions = {}): FakeIo {
  const commands: string[] = [];
  const writes = new Map<string, string>();
  const files = { ...options.files };

  const fails = (command: string): boolean =>
    (options.fails ?? []).some((fragment) => command.includes(fragment));

  const output = (command: string): string => {
    for (const [fragment, value] of Object.entries(options.output ?? {})) {
      if (command.includes(fragment)) {
        return value;
      }
    }

    return "";
  };

  const io: FakeIo = {
    commands,
    writes,

    exec: vi.fn((command: string) => {
      commands.push(command);

      if (fails(command)) {
        throw new Error(`Command failed: ${command}`);
      }

      return output(command);
    }),

    execSilent: vi.fn((command: string) => {
      commands.push(command);

      // A failing probe is an answer, not an error
      return fails(command) ? "" : output(command).trim();
    }),

    commandExists: vi.fn((command: string) =>
      (options.present ?? []).includes(command),
    ),

    writeFile: vi.fn((path: string, content: string) => {
      writes.set(path, content);
      files[path] = content;
    }),

    fileExists: vi.fn((path: string) => path in files),

    readFile: vi.fn((path: string) => files[path] ?? ""),

    env: options.env ?? {},

    written(path: string): string {
      return writes.get(path) ?? "";
    },

    ran(fragment: string): boolean {
      return commands.some((command) => command.includes(fragment));
    },
  };

  return io;
}

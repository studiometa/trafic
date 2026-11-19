import { describe, it, expect } from "vitest";
import { summarizeDeletions, formatDeletions } from "../src/ssh.js";

/** Shaped like real `rsync -azv --delete` output. */
const REAL_OUTPUT = `sending incremental file list
deleting wpml-string-translation/locale/jed/po/wpml-de_DE.po
deleting wpml-string-translation/locale/jed/po/wpml-ar.po
deleting wpml-string-translation/locale/jed/po/
deleting headers-security-advanced-hsts-wp/readme.txt
deleting headers-security-advanced-hsts-wp/index.php
deleting headers-security-advanced-hsts-wp/
./
classic-editor/classic-editor.php
wordfence/wordfence.php

sent 1,234 bytes  received 56 bytes  2,580.00 bytes/sec
total size is 12,345  speedup is 9.57
`;

describe("summarizeDeletions", () => {
  it("counts the deleted paths", () => {
    expect(summarizeDeletions(REAL_OUTPUT).files).toBe(6);
  });

  it("groups them by top-level entry", () => {
    // A whole plugin disappearing is the thing worth seeing; the files
    // inside it are noise
    expect(summarizeDeletions(REAL_OUTPUT).entries).toEqual([
      "headers-security-advanced-hsts-wp",
      "wpml-string-translation",
    ]);
  });

  it("ignores transferred files, which are not deletions", () => {
    const summary = summarizeDeletions(REAL_OUTPUT);

    expect(summary.entries).not.toContain("classic-editor");
    expect(summary.entries).not.toContain("wordfence");
  });

  it("reports nothing for a sync that deleted nothing", () => {
    const summary = summarizeDeletions("sending incremental file list\n./\ndist/app.js\n");

    expect(summary).toEqual({ files: 0, entries: [] });
  });

  it("handles empty output", () => {
    expect(summarizeDeletions("")).toEqual({ files: 0, entries: [] });
  });

  it("does not treat a filename containing the word as a deletion", () => {
    // Only a line that starts with "deleting " is one
    const summary = summarizeDeletions("src/deleting-helper.ts\nnotes/deleting.md\n");

    expect(summary.files).toBe(0);
  });

  it("strips a leading ./ so the entry is not empty", () => {
    expect(summarizeDeletions("deleting ./vendor/foo.php\n").entries).toEqual(["vendor"]);
  });

  it("keeps a deleted top-level file as its own entry", () => {
    expect(summarizeDeletions("deleting stale.txt\n").entries).toEqual(["stale.txt"]);
  });
});

describe("formatDeletions", () => {
  it("says nothing when nothing was removed", () => {
    expect(formatDeletions({ files: 0, entries: [] })).toBeUndefined();
  });

  it("names the entries", () => {
    expect(formatDeletions(summarizeDeletions(REAL_OUTPUT))).toBe(
      "removed 6 paths under: headers-security-advanced-hsts-wp, wpml-string-translation",
    );
  });

  it("uses the singular for one path", () => {
    expect(formatDeletions({ files: 1, entries: ["vendor"] })).toBe(
      "removed 1 path under: vendor",
    );
  });

  it("caps the list so a big prune stays readable", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g"];

    expect(formatDeletions({ files: 99, entries })).toBe(
      "removed 99 paths under: a, b, c, d, e, and 2 more",
    );
  });

  it("does not add a suffix when the list fits exactly", () => {
    const entries = ["a", "b", "c", "d", "e"];

    expect(formatDeletions({ files: 5, entries })).not.toContain("more");
  });
});

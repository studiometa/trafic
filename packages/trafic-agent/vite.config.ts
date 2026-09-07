import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  test: {
    coverage: {
      // Test helpers are not production code
      exclude: ["test/**", "*.config.ts", "dist/**"],
      // A floor, not a target. Set just under the current numbers so a drop
      // fails CI while an improvement does not. Raise them when coverage
      // rises — two untested parsers, loadProjectList and routePath, each
      // hid a bug for nine releases, which is what this is here to prevent.
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 70,
        lines: 75,
      },
    },
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      entry: {
        index: "./src/index.ts",
        cli: "./src/cli.ts",
        server: "./src/server.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        ...Object.keys(pkg.dependencies ?? {}),
      ],
    },
    target: "node24",
    minify: false,
    sourcemap: true,
  },
});

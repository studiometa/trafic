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
      // fails CI while an improvement does not.
      thresholds: {
        statements: 95,
        branches: 92,
        functions: 100,
        lines: 95,
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
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
    target: "node24",
    minify: false,
    sourcemap: true,
  },
});

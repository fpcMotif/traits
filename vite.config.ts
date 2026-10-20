import { Record } from "effect"
import { defineConfig } from "vite-plus"

import custom from "./rules/index.ts"

const toolingIgnores = ["**/.worktrees/**", ".agents/**", "repos/**"]

export default defineConfig({
  fmt: {
    ignorePatterns: toolingIgnores,
    overrides: [
      {
        files: ["**/*.md"],
        options: { printWidth: 80 }
      }
    ],
    proseWrap: "always",
    semi: false,
    sortImports: {},
    sortPackageJson: {},
    trailingComma: "none"
  },
  lint: {
    ignorePatterns: toolingIgnores,
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "custom", specifier: "./rules/index.ts" }
    ],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "typescript/no-import-type-side-effects": "error",
      ...Record.mapEntries(custom.rules, (_, name) => [`custom/${name}`, "error"] as const),
      "vite-plus/prefer-vite-plus-imports": "error"
    }
  },
  test: {
    projects: ["rules/vite.config.ts", "traits/vite.config.ts"]
  }
})

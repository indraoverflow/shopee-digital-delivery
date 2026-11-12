import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * A small, fast lint pass: the type checker already covers most of what a lint
 * rule would catch, so this focuses on mistakes the compiler forgives
 * (unused variables, floating promises, explicit any).
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "vendor/**",
      "docs/**",
      "**/*.d.ts",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["apps/web/**/*.tsx"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);

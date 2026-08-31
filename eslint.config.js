import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sharedRules = {
  "no-console": "off",
  "comma-dangle": ["error", "only-multiline"],
  indent: ["error", 2],
  "linebreak-style": ["error", "unix"],
  quotes: ["error", "double"],
  semi: ["error", "always"],
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
  "prefer-const": "error",
  "no-var": "error",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "copilot/**",
      "dist/**",
      "dist-refactor/**",
      "coverage/**",
      "*.md",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "tests/**/*.js", "scripts/**/*.{js,mjs}", "*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: sharedRules,
  },
  {
    files: [
      "src/**/*.ts",
      "scripts/refactor/**/*.ts",
      "tests/refactor/**/*.ts",
      "tests/live/**/*.ts",
      "*.config.ts",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...sharedRules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
];

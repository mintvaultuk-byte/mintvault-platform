import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-console": "off",
      "no-undef": "off",
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-constant-binary-expression": "warn",
      "no-async-promise-executor": "warn",
      "prefer-const": "warn",
      "preserve-caught-error": "off",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "migrations/",
      "**/server/scripts/**",
      "**/scripts/cricut-app/**",
      "**/.claude/worktrees/**",
      "*.cjs",
    ],
  },
);

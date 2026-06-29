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
    // Build output, deps, generated migrations and bundled .cjs are not linted.
    //
    // scripts/cricut-app/ and server/scripts/ are gitignored (.gitignore:50,54),
    // standalone LOCAL tools — a vendored/minified Cricut helper and one-off
    // server scripts — NOT Release Train application source and not part of the
    // Vite/esbuild build. They carry ~1.6k errors from minified/generated code;
    // linting them is pure noise that app workflow would never fix. Excluded at
    // the boundary here rather than by editing the vendored/minified files.
    // Tracked application code (client/src, server, shared) is NOT excluded — its
    // remaining findings are warnings, which stay visible.
    ignores: [
      "dist/",
      "node_modules/",
      "migrations/",
      "*.cjs",
      "scripts/cricut-app/**",
      "server/scripts/**",
    ],
  },
);

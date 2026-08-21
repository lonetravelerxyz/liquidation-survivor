import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "data/", "contracts/", "src/views/", "web/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Express error middleware must declare `next` to register as an error handler.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Scripts parse third-party payloads we do not own; precise types buy nothing there.
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);

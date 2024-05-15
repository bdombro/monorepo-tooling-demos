// @ts-check

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommended, {
  languageOptions: {
    parserOptions: {
      ecmaVersion: "latest",
      project: "./tsconfig.json",
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-unused-vars": "warn",
    "no-empty": "off",
  },
});

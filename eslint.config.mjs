import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "node_modules/**", "public/**", "test-results/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
);

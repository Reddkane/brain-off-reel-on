import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import pureBoundary from "./tooling/eslint/pure-boundary.mjs";
import effectBoundary from "./tooling/eslint/effect-boundary.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", "node_modules/**", "coverage/**", ".cache/**", "**/*.tsbuildinfo", "next-env.d.ts"]),
  {
    files: ["src/**/*.{ts,tsx,mjs,js}", "scripts/**/*.ts"],
    ignores: ["src/domain/**", "src/recommendation/**"],
    plugins: { effects: { rules: { boundary: effectBoundary } } },
    rules: { "effects/boundary": "error" },
  },
  {
    files: ["src/domain/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "src/recommendation/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    linterOptions: { noInlineConfig: true },
    plugins: { local: { rules: { "pure-boundary": pureBoundary } } },
    rules: {
      "local/pure-boundary": "error",
      "no-restricted-imports": ["error", {
        patterns: [{ regex: "^(?!\\.\\.?/)", message: "Pure source uses relative imports only." }],
      }],
      "no-restricted-syntax": ["error",
        { selector: "ImportExpression", message: "Pure source cannot dynamically import." },
        { selector: "ExpressionStatement[directive='use client']", message: "Framework directives do not belong in pure source." },
        { selector: "ExpressionStatement[directive='use server']", message: "Framework directives do not belong in pure source." },
        { selector: "TSModuleDeclaration[global=true]", message: "Pure source cannot augment runtime globals." },
        {
          selector: "ClassDeclaration[declare=true], TSEnumDeclaration[declare=true], TSDeclareFunction[declare=true], VariableDeclaration[declare=true] > VariableDeclarator:not([id.typeAnnotation.typeAnnotation.type='TSTypeOperator'][id.typeAnnotation.typeAnnotation.operator='unique'][id.typeAnnotation.typeAnnotation.typeAnnotation.type='TSSymbolKeyword'])",
          message: "Pure source cannot declare ambient runtime values; unique symbol type brands are allowed.",
        },
      ],
      "no-restricted-globals": ["error", { name: "globalThis", message: "Pass runtime effects into pure code through explicit inputs." }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "@typescript-eslint/no-require-imports": ["error", { allowAsImport: false }],
      "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: true }],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/triple-slash-reference": ["error", { lib: "never", path: "never", types: "never" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/domain/**/*.{tsx,mts,cts,js,jsx,mjs,cjs}", "src/recommendation/**/*.{tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "Program",
        message: "Pure source must use .ts files so every accepted module receives the independent pure typecheck.",
      }],
    },
  },
]);

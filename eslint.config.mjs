import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

// jsx-a11y recommended rules at WARN (feature-plan-ux-foundations.md §4.8; UX-5 turns warnings into errors). Severity
// only: 'off' (and ['off', …]) stays off, everything else becomes warn with its options kept. Rules only — the plugin is
// already registered by eslint-config-next, and registering it again throws "Cannot redefine plugin" (trap T-F).
const toWarn = (entry) => {
  if (Array.isArray(entry)) return entry[0] === "off" || entry[0] === 0 ? entry : ["warn", ...entry.slice(1)];
  return entry === "off" || entry === 0 ? entry : "warn";
};
// A severity-only entry ("warn") keeps the options an earlier config set, so Next's alt-text options (next/image as an
// img) survive the override.
const a11yRules = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([name, entry]) => [name, toWarn(entry)]),
);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Relax strict rules across the codebase — Auth.js session casting, server actions,
  // and test files all use `any` extensively. These are intentional, not bugs.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "react/no-unescaped-entities": "off",
      "prefer-const": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  // Accessibility (feature-plan-ux-foundations.md §4.8).
  {
    files: ["src/**/*.tsx"],
    settings: {
      "jsx-a11y": {
        // <Anchor component="button"> counts as a button, etc.
        polymorphicPropName: "component",
        components: { ActionIcon: "button", UnstyledButton: "button", CloseButton: "button", Anchor: "a" },
      },
    },
    rules: {
      ...a11yRules,
      "no-restricted-syntax": [
        "warn",
        {
          selector: "JSXOpeningElement[name.name='ActionIcon']:not(:has(> JSXAttribute[name.name='aria-label'])):not(:has(> JSXSpreadAttribute))",
          message: "ActionIcon needs an aria-label",
        },
        {
          selector: "JSXOpeningElement[name.name='Anchor']:has(> JSXAttribute[name.name='onClick']):not(:has(> JSXAttribute[name.name=/^(href|component)$/]))",
          message: "Anchor with onClick needs href or component=\"button\"",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "tmp-next/**",
  ]),
]);

export default eslintConfig;

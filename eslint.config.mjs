// @ts-check
import tseslint from "typescript-eslint";
import robloxTs from "eslint-plugin-roblox-ts";

// typescript-eslint's strict type-checked rules, with three changes for roblox-ts.
export default tseslint.config(
	{ ignores: ["out/**", "build/**", "node_modules/**", "**/*.mjs", "**/*.js"] },
	...tseslint.configs.strictTypeChecked,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				// The spec config covers every file under src, tests included.
				project: "./tsconfig.spec.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: { "roblox-ts": robloxTs },
		rules: {
			"roblox-ts/no-null": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			// Numbers in template strings are fine in Luau.
			"@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
			// roblox-ts types `array[i]` as never undefined, so this rule would flag nil checks
			// that are needed at runtime.
			"@typescript-eslint/no-unnecessary-condition": "off",
		},
	},
);

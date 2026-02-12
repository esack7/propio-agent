## Why

The project uses CommonJS modules, which prevents adopting modern ESM-only dependencies (e.g., chalk v5+, ora v6+). The Node.js ecosystem is converging on ESM as the standard module format, and an increasing number of libraries have dropped CommonJS support. Migrating now unblocks the upcoming CLI color/interactivity work and avoids accumulating compatibility debt.

## What Changes

- **BREAKING**: Add `"type": "module"` to package.json — the package is now ESM
- Update `tsconfig.json` to use `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`
- Add `.js` extensions to all relative import paths across source and test files (~74 imports)
- Replace `__dirname` usage in `src/index.ts` with `import.meta.url` + `fileURLToPath`
- Update Jest configuration to use ts-jest ESM preset
- Update `dev` script to use the ts-node ESM loader

## Capabilities

### New Capabilities

- `esm-modules`: ESM module system configuration, import resolution rules, and build tooling requirements

### Modified Capabilities

_(None — existing capability requirements are unchanged. This migration affects how modules are loaded, not what they do.)_

## Impact

- **Build config**: `tsconfig.json` module/moduleResolution settings change. `jest.config.js` must use ESM-compatible preset.
- **All source files**: Every relative import gains a `.js` extension. One `__dirname` reference is replaced.
- **All test files**: Same `.js` extension treatment. Jest ESM configuration applies.
- **Dev workflow**: `ts-node` invocation changes to use `--esm` flag or `--loader ts-node/esm`.
- **Downstream consumers**: The compiled output in `dist/` will be ESM instead of CommonJS. Any code that `require()`s this package would break.

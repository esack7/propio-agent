## Context

The project currently compiles with `"module": "commonjs"` (tsconfig.json) and has no `"type"` field in package.json (defaulting to CommonJS). All 34 TypeScript files use ES6 `import` syntax already, but TypeScript compiles them down to `require()` calls. There are no explicit `require()` calls in source. One `__dirname` reference exists in `src/index.ts`. Jest is configured with ts-jest in CommonJS mode. The dev script uses `ts-node src/index.ts`.

## Goals / Non-Goals

**Goals:**

- Convert the project to native ESM so all source, tests, and build output use ES modules
- Maintain full test suite passing after migration
- Keep the dev workflow functional (`npm run dev`, `npm test`)

**Non-Goals:**

- Dual CJS/ESM package exports (no CommonJS fallback)
- Upgrading third-party dependencies (that's for downstream changes)
- Changing the test framework or test structure

## Decisions

### 1. Use `"module": "NodeNext"` with `"moduleResolution": "NodeNext"`

**Chosen**: `NodeNext` for both `module` and `moduleResolution` in tsconfig.json.

**Alternatives considered**:

- _`"module": "ESNext"` with `"moduleResolution": "bundler"`_: Designed for bundled environments (Vite, webpack). Does not enforce `.js` extensions, which can lead to runtime failures in Node.js. Not appropriate for a CLI tool that runs directly on Node.
- _`"module": "ES2022"`_: Works but `NodeNext` is the TypeScript-recommended setting for Node.js projects and tracks Node's evolving module behavior automatically.

**Rationale**: `NodeNext` enforces Node.js module resolution rules at compile time—TypeScript will error if `.js` extensions are missing on relative imports, catching mistakes before runtime.

### 2. Rename `jest.config.js` to `jest.config.cjs`

With `"type": "module"` in package.json, all `.js` files are treated as ESM. Jest's config file uses `module.exports`, which is CommonJS syntax.

**Chosen**: Rename to `jest.config.cjs` so Node treats it as CommonJS regardless of the package type.

**Alternatives considered**:

- _Convert to `jest.config.ts`_: Requires additional ts-jest/ts-node configuration to transpile the config file itself. Adds complexity for no benefit.
- _Convert to ESM syntax (`export default`)_: Jest's config loading with ESM can be unreliable depending on version. The `.cjs` rename is the simplest fix.

### 3. Use ts-jest ESM preset for tests

**Chosen**: Switch the Jest preset from `"ts-jest"` to `"ts-jest/presets/default-esm"` and add `extensionsToTreatAsEsm: [".ts"]`. Set the `transform` config to pass `useESM: true` to ts-jest. Run Jest with `NODE_OPTIONS="--experimental-vm-modules"`.

**Rationale**: ts-jest 29.4.6 (already installed) has built-in ESM support via this preset. No new dependencies needed.

### 4. Use `tsx` for the dev script instead of `ts-node`

**Chosen**: Replace `ts-node` with `tsx` for the dev script. `tsx` handles ESM TypeScript transparently without extra flags or configuration.

**Alternatives considered**:

- _`ts-node --esm`_: Known to be fragile with ESM—requires `--experimental-specifier-resolution=node` on some setups and can fail with certain import patterns. The ts-node GitHub issues have many ESM-related bug reports.
- _`node --loader ts-node/esm`_: The `--loader` flag is deprecated in newer Node.js versions in favor of `--import` with register hooks. Configuration is complex.

**Trade-off**: Adds `tsx` as a dev dependency. This is a well-maintained, widely-used tool (by the esbuild team) that works reliably with ESM. `ts-node` can remain in devDependencies for now since ts-jest may still use it internally, or it can be removed.

### 5. Replace `__dirname` with `import.meta` pattern

The single `__dirname` usage in `src/index.ts` will be replaced with the standard ESM equivalent:

```typescript
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

This is the idiomatic ESM pattern endorsed by the Node.js documentation.

### 6. Remove `esModuleInterop` from tsconfig

**Chosen**: Remove `esModuleInterop: true` from tsconfig.json. With native ESM, default imports work correctly without the interop flag. The flag was a CommonJS-era workaround.

**Caveat**: If any dependency's type declarations rely on `esModuleInterop` behavior, imports may need adjustment (e.g., `import * as fs from "fs"` stays as-is, `import chalk from "chalk"` works natively in ESM). This will be validated during implementation.

## Risks / Trade-offs

- **Jest ESM support is still flagged as experimental** → Mitigation: `--experimental-vm-modules` is required but has been stable in practice for ts-jest projects. Jest 30 has improved ESM handling. If issues arise, tests can be run with the flag in CI via the `test` script's `NODE_OPTIONS`.
- **`tsx` is a new dev dependency** → Mitigation: `tsx` is lightweight (uses esbuild under the hood), actively maintained, and only used for development. It does not affect production builds.
- **Import extension changes touch every file** → Mitigation: This is a mechanical change (add `.js` to relative imports). TypeScript's `NodeNext` resolution will produce compile errors for any missed import, so the compiler acts as a safety net.
- **Third-party library compatibility** → Mitigation: All three production dependencies (`@aws-sdk/client-bedrock-runtime`, `fast-glob`, `ollama`) ship ESM builds. Node built-ins (`fs`, `path`, `readline`, etc.) work natively in ESM.

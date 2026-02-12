## 1. Package and TypeScript Configuration

- [x] 1.1 Add `"type": "module"` to package.json
- [x] 1.2 Update tsconfig.json: change `"module"` to `"NodeNext"`, add `"moduleResolution": "NodeNext"`, remove `"esModuleInterop": true`

## 2. Source File Imports

- [x] 2.1 Add `.js` extensions to all relative imports in `src/index.ts` and `src/agent.ts`
- [x] 2.2 Add `.js` extensions to all relative imports in `src/providers/` files (interface.ts, types.ts, config.ts, configLoader.ts, factory.ts, ollama.ts, bedrock.ts, openrouter.ts)
- [x] 2.3 Add `.js` extensions to all relative imports in `src/tools/` files (interface.ts, types.ts, registry.ts, factory.ts, bash.ts, fileSystem.ts, search.ts, sessionContext.ts)

## 3. ESM Globals Replacement

- [x] 3.1 Replace `__dirname` in `src/index.ts` with `import.meta.url` + `fileURLToPath`/`dirname` pattern

## 4. Test File Imports

- [x] 4.1 Add `.js` extensions to all relative imports in `src/__tests__/` files
- [x] 4.2 Add `.js` extensions to all relative imports in `src/providers/__tests__/` files
- [x] 4.3 Add `.js` extensions to all relative imports in `src/tools/__tests__/` files

## 5. Jest Configuration

- [x] 5.1 Rename `jest.config.js` to `jest.config.cjs`
- [x] 5.2 Update Jest config: change preset to `"ts-jest/presets/default-esm"`, add `extensionsToTreatAsEsm: [".ts"]`, add transform config with `useESM: true`
- [x] 5.3 Update `test` script in package.json to set `NODE_OPTIONS="--experimental-vm-modules"`

## 6. Dev Script

- [x] 6.1 Install `tsx` as a dev dependency
- [x] 6.2 Update `dev` script in package.json from `ts-node src/index.ts` to `tsx src/index.ts`

## 7. Validation

- [x] 7.1 Run `tsc --noEmit` and fix any remaining compile errors
- [x] 7.2 Run `npm test` and verify all tests pass (284/284 tests passing - 100%)
- [x] 7.3 Run `npm run build && npm start` and verify the application starts
- [x] 7.4 Run `npm run dev` and verify the application starts

## 8. Fix Remaining Test Mocking Issues

- [x] 8.1 Fix Jest ESM mocking in all test files using `jest.unstable_mockModule()` pattern - all tests now passing

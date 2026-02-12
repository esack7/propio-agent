## ADDED Requirements

### Requirement: Package declares ESM module type

The package.json SHALL include `"type": "module"` to declare the package as ESM.

#### Scenario: Package is recognized as ESM

- **WHEN** Node.js loads any `.js` file from the package
- **THEN** it SHALL be parsed as an ES module (not CommonJS)

### Requirement: TypeScript compiles to ESM output

The tsconfig.json SHALL use `"module": "NodeNext"` and `"moduleResolution": "NodeNext"` so that TypeScript emits ESM-compatible output and enforces Node.js module resolution rules.

#### Scenario: Compiled output uses ESM syntax

- **WHEN** the project is built with `tsc`
- **THEN** the output files in `dist/` SHALL use `import`/`export` statements (not `require()`/`module.exports`)

#### Scenario: Missing import extension causes compile error

- **WHEN** a source file contains a relative import without a `.js` extension (e.g., `import { Foo } from "./foo"`)
- **THEN** TypeScript SHALL report a compile error

### Requirement: All relative imports use .js extensions

Every relative import path in source and test files SHALL include the `.js` file extension to satisfy Node.js ESM resolution.

#### Scenario: Source file relative import

- **WHEN** a TypeScript source file imports from a relative path
- **THEN** the import specifier SHALL end with `.js` (e.g., `import { Agent } from "./agent.js"`)

#### Scenario: Test file relative import

- **WHEN** a TypeScript test file imports from a relative path
- **THEN** the import specifier SHALL end with `.js` (e.g., `import { Agent } from "../agent.js"`)

### Requirement: No **dirname or **filename globals

Source files SHALL NOT use the CommonJS globals `__dirname` or `__filename`. The ESM equivalents (`import.meta.url` with `fileURLToPath`) SHALL be used instead.

#### Scenario: Directory path resolution in ESM

- **WHEN** a source file needs the directory path of the current module
- **THEN** it SHALL derive it from `import.meta.url` using `fileURLToPath` and `dirname`

### Requirement: Jest runs tests in ESM mode

The Jest configuration SHALL support running TypeScript tests as ES modules using the ts-jest ESM preset.

#### Scenario: Test suite passes in ESM mode

- **WHEN** `npm test` is executed
- **THEN** all existing tests SHALL pass without modification to test logic (only import paths change)

#### Scenario: Jest config is CommonJS-compatible

- **WHEN** the project has `"type": "module"` in package.json
- **THEN** the Jest config file SHALL use a `.cjs` extension so it is parsed as CommonJS

### Requirement: Dev script runs TypeScript ESM directly

The dev script SHALL execute TypeScript source files as ESM without a prior compilation step.

#### Scenario: Dev script starts the application

- **WHEN** `npm run dev` is executed
- **THEN** the application SHALL start and behave identically to the compiled `npm start`

### Requirement: Built application runs as ESM

The compiled application SHALL run correctly as ESM via `node dist/index.js`.

#### Scenario: Production start

- **WHEN** the project is built with `npm run build` and started with `npm start`
- **THEN** the application SHALL start without module resolution errors

## 1. Banner module

- [x] 1.1 Add `src/ui/banner.ts` with the Propio Agent ASCII-art constant (PROPIO block + "A G E N T" line)
- [x] 1.2 Export `printStartupBanner()` that writes the banner to stdout (optionally use existing `src/ui` formatting for consistency)

## 2. Entrypoint wiring

- [x] 2.1 In `src/index.ts`, call `printStartupBanner()` immediately after the sandbox delegation block when not delegating, before `getConfigPath()` or any other output

## 3. Verification

- [x] 3.1 Add a unit test (e.g. in `src/ui/__tests__/banner.test.ts`) that the banner string includes "PROPIO" and "A G E N T"
- [x] 3.2 Run `npm test` and `npm run build` to confirm no regressions

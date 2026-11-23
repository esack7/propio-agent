# Outcome evaluation fixtures

Run the credential-free coding fixture checks from the repository root.

```sh
npm run test:outcomes:coding
```

`fix-media-type` starts with a failing `node check.mjs` that exposes an incorrect SVG mapping. `extend-locales` requires the same feature in two catalogs. The external grader checks the resulting files, including unrelated entries and the supplied check. It reads the candidate as data. Only the regression test executes the check on its own known fixture.

A runner calls `createCodingTrial(parent, id)` to get a fresh workspace and prompt, then calls `gradeCodingTrial(workspace, id)` after the agent exits. Keep runner metadata outside the workspace and remove the trial directory after grading. The fixture checks use known edits to validate grading. They do not measure a model’s success rate.

Run the actual built CLI against both tasks with a credential-free, loopback-only
scripted Ollama endpoint:

```sh
npm run build && node benchmarks/outcomes/runner.mjs
```

Each scheduled trial starts a separate CLI process in JSON/stdin mode with
`accept-edits`, a fresh workspace and home, no inherited credentials or MCP
configuration, and a 15-second deadline. Temporary state is removed after grading.
The JSON output retains failures and errors, including startup failure, nonzero
exit, timeout, and grader I/O failure; later scheduled trials continue. Cleanup
failures are reported separately. Scripted passes validate the harness and tool
path, not model quality.

External calls require explicit selection of a complete provider configuration:
`node benchmarks/outcomes/runner.mjs --provider-config /path/to/providers.json`.
Only that file is copied into the trial home; credentials must be supplied in the
selected configuration rather than inherited environment variables. Configurations
and raw CLI output are never printed in outcomes. The same deadline applies.

After building, run runner integration coverage with
`node --test benchmarks/outcomes/runner.test.mjs`.

# Outcome evaluation fixtures

Run the credential-free coding fixture checks from the repository root.

```sh
npm run test:outcomes:coding
```

`fix-media-type` starts with a failing `node check.mjs` that exposes an incorrect SVG mapping. `extend-locales` requires the same feature in two catalogs. The external grader checks the resulting files, including unrelated entries and the supplied check. It reads the candidate as data. Only the regression test executes the check on its own known fixture.

A runner calls `createCodingTrial(parent, id)` to get a fresh workspace and prompt, then calls `gradeCodingTrial(workspace, id)` after the agent exits. Keep runner metadata outside the workspace and remove the trial directory after grading. The fixture checks use known edits to validate grading. They do not measure a model’s success rate.

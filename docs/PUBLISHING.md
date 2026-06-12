# Publishing `@propio-ai/agent`

This document describes the repeatable workflow for publishing the npm package while keeping the installed CLI command as `propio`.

## Package Identity

- npm package name: `@propio-ai/agent`
- CLI command: `propio`
- Published entrypoint: `bin/propio.cjs`
- Runtime build output: `dist/index.js`

## When To Publish

Publish when you:

- Add or change application behavior
- Change dependencies or dependency versions
- Update the public CLI/docs
- Bump the release version

## Version Bump

Use one of the standard npm version commands, but make the version bump on a
release branch instead of committing directly to `main`:

```bash
git checkout main
git pull --ff-only
git checkout -b release/v<version>
npm version patch --no-git-tag-version
```

Use `minor` or `major` instead of `patch` when the change warrants it. Replace
`<version>` in the branch name with the version you are releasing, for example
`release/v1.0.2`.

The `--no-git-tag-version` flag keeps npm from creating a local release commit
and tag before the protected-branch PR has merged. The version bump should update
both:

- `package.json`
- `npm-shrinkwrap.json`

Commit those files, push the release branch, and merge it through the normal PR
flow:

```bash
git status --short
git add package.json npm-shrinkwrap.json
git commit -m "chore: release v<version>"
git push -u origin release/v<version>
```

Do not publish from the release branch. Publish only after the version bump PR is
merged and your local `main` contains the release commit:

```bash
git checkout main
git pull --ff-only
```

If this repository uses git tags for releases, create and push the tag after the
PR has merged:

```bash
git tag v<version>
git push origin v<version>
```

## Dependency Updates

If you add, remove, or update dependencies:

```bash
npm install <package>@<version>
npm shrinkwrap
```

`npm-shrinkwrap.json` is committed so sandbox builds and published installs use the same resolved dependency tree.

## Pre-Publish Checklist

Run the release checks from the repository root:

```bash
npm test
npm run build
npm run format:check
npm pack --dry-run
```

The `npm pack --dry-run` output should include:

- `dist/`
- `bin/propio.cjs`
- `bin/propio-sandbox`
- `docker-compose.yml`
- `Dockerfile`
- `README.md`
- `LICENSE`
- `npm-shrinkwrap.json`

## Smoke Test

Create a tarball and install it in a clean temp directory:

```bash
npm pack
mkdir -p /tmp/propio-release-test
cd /tmp/propio-release-test
npm install /path/to/propio-ai-agent-<version>.tgz
```

Then verify:

```bash
./node_modules/.bin/propio --help
printf 'hello\n' | ./node_modules/.bin/propio --no-interactive
mkdir -p /tmp/propio-release-test/other-workspace
cd /tmp/propio-release-test/other-workspace
../node_modules/.bin/propio --help
```

The key checks are:

- `propio --help` exits cleanly
- `propio` runs from the current working directory

If you also want to verify sandbox packaging, run that separately from the installed tarball directory after confirming all sandbox prerequisites:

- `~/.propio/providers.json` exists
- Docker is installed and running
- the sandbox image has been built for the installed package layout

Example:

```bash
cd /tmp/propio-release-test
docker compose -f node_modules/@propio-ai/agent/docker-compose.yml build
./node_modules/.bin/propio --sandbox
```

## Publish

When the version bump PR has merged into `main` and the tarball and smoke test
look good:

```bash
npm publish --access public
```

## After Publish

- Confirm the package page and version on npm
- Record the published version in the release notes or changelog if the repo uses one
- If the next release changes dependencies, refresh `npm-shrinkwrap.json` again before publishing

# Publishing `propio-agent`

This document describes the repeatable workflow for publishing the npm package while keeping the installed CLI command as `propio`.

## Package Identity

- npm package name: `propio-agent`
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

Use one of the standard npm version commands:

```bash
npm version patch
```

Use `minor` or `major` instead when the change warrants it.

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
npm install /path/to/propio-agent-<version>.tgz
```

Then verify:

```bash
./node_modules/.bin/propio --help
printf 'hello\n' | ./node_modules/.bin/propio --no-interactive
mkdir -p /tmp/other-workspace
cd /tmp/other-workspace
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
docker compose -f node_modules/propio-agent/docker-compose.yml build
./node_modules/.bin/propio --sandbox
```

## Publish

When the tarball and smoke test look good:

```bash
npm publish --access public
```

## After Publish

- Confirm the package page and version on npm
- Record the published version in the release notes or changelog if the repo uses one
- If the next release changes dependencies, refresh `npm-shrinkwrap.json` again before publishing

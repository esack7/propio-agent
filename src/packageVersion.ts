import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const installedPackageJsonPathCache = new Map<string, string>();
const installedPackageVersionCache = new Map<string, string>();

function installedPackageCacheKey(
  packageName: string,
  entryModuleUrl: string,
): string {
  return `${entryModuleUrl}\0${packageName}`;
}

/** Resolves the repo-root `package.json` from a top-level src/dist module URL. */
export function resolvePackageJsonPath(entryModuleUrl: string): string {
  const entryFilePath = fileURLToPath(entryModuleUrl);
  const entryDir = path.dirname(entryFilePath);
  const repoRoot = path.resolve(entryDir, "..");
  return path.join(repoRoot, "package.json");
}

/** Reads the semver `version` field from a `package.json` file. */
export function readPackageVersionFromPath(packageJsonPath: string): string {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Invalid or missing version in ${packageJsonPath}`);
  }
  return parsed.version;
}

/** Returns the CLI package version from the repo-root `package.json`. */
export function getPackageVersion(
  entryModuleUrl: string = import.meta.url,
): string {
  return readPackageVersionFromPath(resolvePackageJsonPath(entryModuleUrl));
}

/** Resolves an installed package's own package.json without requiring it to export that file. */
export function resolveInstalledPackageJsonPath(
  packageName: string,
  entryModuleUrl: string = import.meta.url,
): string {
  const cacheKey = installedPackageCacheKey(packageName, entryModuleUrl);
  const cached = installedPackageJsonPathCache.get(cacheKey);
  if (cached) return cached;

  let directory = path.dirname(fileURLToPath(entryModuleUrl));
  while (true) {
    const candidate = path.join(
      directory,
      "node_modules",
      packageName,
      "package.json",
    );
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: unknown;
      };
      if (parsed.name === packageName) {
        const resolved = fs.realpathSync(candidate);
        installedPackageJsonPathCache.set(cacheKey, resolved);
        return resolved;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Unable to resolve installed package metadata: ${packageName}`,
  );
}

/** Returns the version from an installed package, including a locally linked checkout. */
export function getInstalledPackageVersion(
  packageName: string,
  entryModuleUrl: string = import.meta.url,
): string {
  const cacheKey = installedPackageCacheKey(packageName, entryModuleUrl);
  const cached = installedPackageVersionCache.get(cacheKey);
  if (cached) return cached;

  const version = readPackageVersionFromPath(
    resolveInstalledPackageJsonPath(packageName, entryModuleUrl),
  );
  installedPackageVersionCache.set(cacheKey, version);
  return version;
}

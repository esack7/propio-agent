import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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

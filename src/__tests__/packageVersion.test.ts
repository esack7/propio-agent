import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getInstalledPackageVersion,
  getPackageVersion,
  readPackageVersionFromPath,
  resolveInstalledPackageJsonPath,
  resolvePackageJsonPath,
} from "../packageVersion.js";

describe("packageVersion", () => {
  it("resolves package.json from a dist entry module URL", () => {
    const distEntry = pathToFileURL(
      path.join(process.cwd(), "dist", "index.js"),
    ).href;

    expect(resolvePackageJsonPath(distEntry)).toBe(
      path.join(process.cwd(), "package.json"),
    );
  });

  it("reads version from a package.json file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-pkg-"));
    const packageJsonPath = path.join(dir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "test", version: "9.8.7" }),
    );

    expect(readPackageVersionFromPath(packageJsonPath)).toBe("9.8.7");
  });

  it("returns the repo package version", () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ).version as string;

    expect(getPackageVersion()).toBe(expected);
  });

  it("reads the version from an installed package's own metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "propio-pkg-"));
    const packageDir = path.join(dir, "node_modules", "example-package");
    const packageJsonPath = path.join(packageDir, "package.json");
    const installedEntry = path.join(packageDir, "dist", "index.js");
    fs.mkdirSync(path.dirname(installedEntry), { recursive: true });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "example-package",
        version: "9.8.7-local",
        exports: "./dist/index.js",
      }),
    );
    fs.writeFileSync(installedEntry, "export {};\n");
    const consumerUrl = pathToFileURL(path.join(dir, "consumer.mjs")).href;

    expect(
      resolveInstalledPackageJsonPath("example-package", consumerUrl),
    ).toBe(fs.realpathSync(packageJsonPath));
    expect(getInstalledPackageVersion("example-package", consumerUrl)).toBe(
      "9.8.7-local",
    );
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "example-package",
        version: "10.0.0-changed-on-disk",
        exports: "./dist/index.js",
      }),
    );
    expect(getInstalledPackageVersion("example-package", consumerUrl)).toBe(
      "9.8.7-local",
    );
  });
});

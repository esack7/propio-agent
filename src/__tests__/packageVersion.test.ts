import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getPackageVersion,
  readPackageVersionFromPath,
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
});

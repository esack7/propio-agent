import { describe, it, expect } from "@jest/globals";
import {
  classifyGlobalInstallCommand,
  isUnambiguousGlobalInstall,
} from "../globalInstallGuard.js";

describe("classifyGlobalInstallCommand", () => {
  it.each([
    "npm install -g eslint",
    "sudo npm i --global typescript",
    "brew install ripgrep",
    "apt-get install jq",
    "yarn global add prettier",
    "pipx install black",
    "cargo install ripgrep",
    "gem install bundler",
    "pnpm add -g typescript",
    "dnf install curl",
    "apk add git",
    "pacman -S jq",
    "zypper install vim",
    "brew upgrade node",
    "cd /tmp && npm install -g eslint",
    'sh -c "npm install -g eslint"',
    'bash -lc "brew install ripgrep"',
    "sudo -E npm install -g eslint",
    "npm install --location global eslint",
  ])("matches global install command: %s", (command) => {
    expect(classifyGlobalInstallCommand(command).matched).toBe(true);
  });

  it.each([
    "npm install",
    "npm install lodash -D",
    "pip install -r requirements.txt",
    "brew list",
    'echo "npm install -g eslint"',
    "npm install eslint",
    "pnpm install lodash",
    "yarn add prettier",
  ])("ignores non-global install command: %s", (command) => {
    expect(classifyGlobalInstallCommand(command).matched).toBe(false);
  });

  it("returns a reason when matched", () => {
    const result = classifyGlobalInstallCommand("npm install -g eslint");
    expect(result.reason).toMatch(/npm/i);
  });
});

describe("isUnambiguousGlobalInstall", () => {
  it.each([
    "npm install -g eslint",
    "npm -g install eslint",
    "npm i --global eslint",
    "npm install --location=global eslint",
    "pnpm add -g eslint",
    "yarn global add eslint",
    "brew install ripgrep",
    "apt-get install -y curl",
    "dnf install curl",
    "apk add curl",
    "pipx install black",
    "cargo install ripgrep",
    "gem install rails",
  ])("recognizes %j", (command) => {
    expect(isUnambiguousGlobalInstall(command)).toBe(true);
  });

  it.each([
    // The classifier flags these because "install" appears somewhere.
    ["a script named install", "npm run install -g"],
    ["an exec of a package named install", "npm exec -g install"],
    ["a build target named install", "cargo build --bin install"],
    ["a query about install", "brew info install"],
    ["a gem search", "gem list install"],
    ["apt fetching a source package", "apt-get source install"],
    ["a local yarn add of a package named global", "yarn add global"],
    // Local, not global.
    ["a local npm install", "npm install eslint"],
    // Wrappers and shells hide what runs.
    ["sudo", "sudo apt-get install curl"],
    ["env", "env PATH=/tmp npm install -g eslint"],
    ["an assignment prefix", "PATH=/tmp npm install -g eslint"],
    ["a shell", "sh -c 'npm install -g eslint'"],
    ["a quoted manager", "'npm' install -g eslint"],
    ["a quoted subcommand", "npm 'install' -g eslint"],
    [
      "an option before the subcommand that takes a value",
      "npm --prefix /x install -g eslint",
    ],
    ["a manager whose syntax is not recognized", "pacman -S ripgrep"],
    ["more than one command", "npm install -g a; npm install -g b"],
    ["an unknown program", "installer install -g x"],
    ["an empty command", ""],
  ])("does not recognize %s", (_label, command) => {
    expect(isUnambiguousGlobalInstall(command)).toBe(false);
  });

  it("flags ambiguous cases the classifier still matches, so they keep the install reason", () => {
    expect(classifyGlobalInstallCommand("npm run install -g").matched).toBe(
      true,
    );
    expect(
      classifyGlobalInstallCommand("cargo build --bin install").matched,
    ).toBe(true);
  });
});

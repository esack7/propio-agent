import { describe, it, expect } from "@jest/globals";
import { classifyGlobalInstallCommand } from "../globalInstallGuard.js";

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

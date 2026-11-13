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
    "npm install --location global eslint",
    "npm install -g eslint prettier @scope/tool@1.2.3",
    "npm install -g -- eslint",
    "npm install --global -- -weird-name",
    "npm\tinstall -g eslint",
    "  npm install -g eslint@9.1.0  ",
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
    // The shell joins adjacent quoted and unquoted text into one argument,
    // so these are not the words they appear to be.
    ["a flag joined to quoted text", "npm install -'g'x eslint"],
    ["a flag split by quotes", 'npm install --glob"al" eslint'],
    ["a quoted package", "npm install -g 'eslint'"],
    ["a backslash escape", "npm install -\\g eslint"],
    ["a line continuation", "npm install -g \\\neslint"],
    ["a variable", "npm install $SCOPE eslint"],
    ["a braced variable", "npm install -g ${PKG}"],
    ["a glob", "npm install -g eslint*"],
    ["a brace expansion", "npm install -{g,D} eslint"],
    ["a tilde", "npm install -g ~/tools/pkg"],
    ["a comment", "npm install -g eslint # --no-global"],
    ["history expansion", "npm install -g !!"],
    ["a version range with ^", "npm install -g eslint@^9"],
    ["a newline between words", "npm install -g\neslint"],
    [
      "an option before the subcommand that takes a value",
      "npm --prefix /x install -g eslint",
    ],
    ["a manager whose syntax is not recognized", "pacman -S ripgrep"],
    // npm reads options in order; a later one can make the install local.
    [
      "a global flag undone by --no-global",
      "npm install -g --no-global eslint",
    ],
    [
      "--global undone by --no-global",
      "npm install --global eslint --no-global",
    ],
    ["--no-global before --global", "npm install --no-global --global eslint"],
    ["--global=false", "npm install --global=false eslint"],
    [
      "a non-global location after -g",
      "npm install -g --location=project eslint",
    ],
    [
      "a non-global location with a space",
      "npm install -g --location user eslint",
    ],
    ["combined short flags", "npm install -gD eslint"],
    ["--no-location", "npm install -g --no-location eslint"],
    ["pnpm undone by --no-global", "pnpm add -g --no-global eslint"],
    // npm takes a separate true or false as a boolean option's value.
    ["--global followed by false", "npm install --global false eslint"],
    ["-g followed by false", "npm install -g false eslint"],
    ["a bare true", "npm install -g true"],
    // After --, every argument is a package, not an option.
    ["-g after --", "npm install -- -g eslint"],
    ["--global after --", "npm install eslint -- --global"],
    ["the subcommand after --", "npm -g -- install eslint"],
    // npm expands abbreviated options.
    ["an abbreviated --no-global", "npm install -g --no-glob eslint"],
    ["an abbreviated location", "npm install -g --loc project eslint"],
    // Options npm reads are not interpreted here, so they ask.
    ["--global=true", "npm install --global=true eslint"],
    ["an unrelated option", "npm install -g --save-exact eslint"],
    ["a prefix", "npm install -g --prefix /tmp/x eslint"],
    ["pnpm with an unrelated option", "pnpm add -g --save-dev eslint"],
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

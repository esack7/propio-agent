import { describe, expect, it } from "@jest/globals";
import {
  checkBashAllowedForMode,
  splitShellCommandSegments,
  tokenizeShellCommand,
} from "../bashPolicy.js";

describe("bashPolicy", () => {
  it("tokenizes quoted segments", () => {
    expect(tokenizeShellCommand(`git log --pretty="oneline"`)).toEqual([
      "git",
      "log",
      "--pretty=oneline",
    ]);
  });

  it("splits command segments at shell operators", () => {
    expect(splitShellCommandSegments("git log;rm -rf /tmp/x")).toEqual([
      "git log",
      "rm -rf /tmp/x",
    ]);
    expect(splitShellCommandSegments('git log && echo "ok"')).toEqual([
      "git log",
      'echo "ok"',
    ]);
    expect(splitShellCommandSegments("grep foo 2>/dev/null | wc -l")).toEqual([
      "grep foo 2>/dev/null",
      "wc -l",
    ]);
  });

  it("allows read-only commands in discover mode", () => {
    expect(
      checkBashAllowedForMode("git log --oneline", "discover").allowed,
    ).toBe(true);
    expect(checkBashAllowedForMode("git tag -l", "discover").allowed).toBe(
      true,
    );
    expect(checkBashAllowedForMode("git tag -l v1.0", "discover").allowed).toBe(
      true,
    );
    expect(
      checkBashAllowedForMode("git tag --list v1.0", "discover").allowed,
    ).toBe(true);
    expect(
      checkBashAllowedForMode("grep foo 2>/dev/null", "discover").allowed,
    ).toBe(true);
    expect(
      checkBashAllowedForMode("transform data.txt", "discover").allowed,
    ).toBe(true);
  });

  it("denies mutating commands in plan/discover modes", () => {
    for (const mode of ["plan", "discover"] as const) {
      expect(checkBashAllowedForMode("rm -rf /tmp/x", mode).allowed).toBe(
        false,
      );
      expect(
        checkBashAllowedForMode("git log;rm -rf /tmp/x", mode).allowed,
      ).toBe(false);
      expect(
        checkBashAllowedForMode("git log && rm -rf /tmp/x", mode).allowed,
      ).toBe(false);
      expect(
        checkBashAllowedForMode("sed -i 's/a/b/' file.txt", mode).allowed,
      ).toBe(false);
      expect(checkBashAllowedForMode("git checkout main", mode).allowed).toBe(
        false,
      );
      expect(
        checkBashAllowedForMode("git -C /tmp/repo checkout main", mode).allowed,
      ).toBe(false);
      expect(checkBashAllowedForMode("git tag v1.0", mode).allowed).toBe(false);
      expect(checkBashAllowedForMode("git tag -d foo", mode).allowed).toBe(
        false,
      );
      expect(
        checkBashAllowedForMode("npm install left-pad", mode).allowed,
      ).toBe(false);
    }
  });

  it("allows all commands in execute mode", () => {
    expect(checkBashAllowedForMode("rm -rf /tmp/x", "execute").allowed).toBe(
      true,
    );
    expect(
      checkBashAllowedForMode("git log;rm -rf /tmp/x", "execute").allowed,
    ).toBe(true);
  });
});

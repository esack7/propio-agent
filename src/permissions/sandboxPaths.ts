import * as path from "path";
import { parseRule, type RuleEffect } from "../policy/index.js";
import { PATH_TOOLS } from "./targets.js";

/** Set by the sandbox wrapper: where the mounted project and home are on the host. */
const HOST_WORKSPACE_ENV = "PROPIO_SANDBOX_HOST_WORKSPACE";
const HOST_HOME_ENV = "PROPIO_SANDBOX_HOST_HOME";

/** The host's names for what the sandbox mounts or leaves behind. */
export interface HostPaths {
  /** The project directory on the host, mounted as the container's workspace. */
  readonly workspace: string;
  /** The host user's home directory, which `~/` in a rule refers to. */
  readonly home: string;
}

/**
 * How a sandbox run relates its paths to the host's. `hostPaths` is absent
 * when the container was not told them, in which case rules written with
 * host paths cannot be applied.
 */
export interface SandboxPaths {
  readonly hostPaths?: HostPaths;
  /** Where the copy of the host's `~/.propio` is mounted, if it is. */
  readonly configMount?: string;
}

function absoluteOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && path.posix.isAbsolute(value)
    ? path.posix.normalize(value)
    : undefined;
}

/** The host paths the wrapper passed in, if it passed both. */
export function readHostPaths(
  env: Readonly<Record<string, string | undefined>>,
): HostPaths | undefined {
  const workspace = absoluteOrUndefined(env[HOST_WORKSPACE_ENV]);
  const home = absoluteOrUndefined(env[HOST_HOME_ENV]);
  return workspace !== undefined && home !== undefined
    ? { workspace, home }
    : undefined;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** A host directory and where the sandbox mounts it. */
export interface Mount {
  readonly container: string;
  readonly host: string;
}

/**
 * The mounts a sandbox run makes of host directories: the project, and the
 * copy of the host's `~/.propio` at `configMount` when there is one.
 */
export function sandboxMounts(
  containerWorkspace: string,
  hostPaths: HostPaths,
  configMount?: string,
): Mount[] {
  return [
    { container: containerWorkspace, host: hostPaths.workspace },
    ...(configMount === undefined
      ? []
      : [
          {
            container: configMount,
            host: path.join(hostPaths.home, ".propio"),
          },
        ]),
  ];
}

/**
 * Maps a resolved container path to the path the same file has on the host,
 * so that rules written on the host, with host absolute paths, match it
 * unchanged. Only mounted directories exist in both places. A container
 * path that merely looks like a mounted host path is refused: it is not the
 * host file its name claims, and no rule could be applied to it honestly.
 */
export function createHostPathTranslator(
  mounts: readonly Mount[],
): (resolvedPath: string) => string {
  // The deepest mount first, should one ever lie inside another.
  const ordered = [...mounts].sort(
    (a, b) => b.container.length - a.container.length,
  );
  return (resolvedPath) => {
    const mount = ordered.find(({ container }) =>
      isInside(resolvedPath, container),
    );
    if (mount) {
      return path.join(
        mount.host,
        path.relative(mount.container, resolvedPath),
      );
    }
    const lookalike = ordered.find(
      ({ container, host }) =>
        host !== container && isInside(resolvedPath, host),
    );
    if (lookalike) {
      throw new Error(
        `Cannot judge ${resolvedPath}: inside the sandbox this is not the host directory ${lookalike.host}, which is mounted at ${lookalike.container}`,
      );
    }
    return resolvedPath;
  };
}

/** Whether a rule names files by a host absolute path or the host home. */
export function isHostPathRule(ruleText: string): boolean {
  const { parsed } = parseRule(ruleText);
  if (parsed.kind !== "tool" || parsed.pattern === undefined) return false;
  const { pattern } = parsed;
  return (
    PATH_TOOLS.has(parsed.name) &&
    (pattern.startsWith("/") || pattern === "~" || pattern.startsWith("~/"))
  );
}

/**
 * The first deny or ask rule that cannot be applied because the container
 * does not know the host's paths, as an error to stop on. An allow rule that
 * fails to match only asks more, so it is not a reason to stop.
 */
export function unappliableHostRule(
  rules: ReadonlyArray<{ effect: RuleEffect; rule: string }>,
): string | undefined {
  const blocked = rules.find(
    ({ effect, rule }) => effect !== "allow" && isHostPathRule(rule),
  );
  return blocked === undefined
    ? undefined
    : `Cannot apply the ${blocked.effect} rule ${JSON.stringify(blocked.rule)} in sandbox mode: ` +
        `the sandbox was not told the host's paths (${HOST_WORKSPACE_ENV} and ${HOST_HOME_ENV}), ` +
        "so a rule written with a host path would silently match nothing. " +
        "Start the sandbox with `propio --sandbox`, or write the rule relative to the workspace.";
}

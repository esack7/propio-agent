import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTraceRecorder, TraceMaterialReference } from "./types.js";

interface WorkspaceFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly material?: TraceMaterialReference;
  readonly omittedReason?: string;
}

interface CachedFile {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly file: WorkspaceFile;
}

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

function sensitivePath(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split(/[\\/]/);
  return parts.some((part) =>
    /^(?:\.env(?:\..*)?|\.npmrc|credentials(?:\..*)?|secrets?(?:\..*)?|providers\.json|mcp\.json|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/.test(
      part,
    ),
  );
}

function walkFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolutePath));
    else files.push(path.relative(root, absolutePath));
  }
  return files;
}

function listWorkspaceFiles(root: string): { paths: string[]; scope: string } {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return {
      paths: [
        ...new Set(output.toString("utf8").split("\0").filter(Boolean)),
      ].sort(),
      scope: "git_tracked_and_untracked",
    };
  } catch {
    return {
      paths: walkFiles(root).sort(),
      scope: "filesystem_without_build_directories",
    };
  }
}

/** Explicit workspace capture for a private full trace. */
export class WorkspaceTraceCapture {
  private readonly root: string;
  private cache = new Map<string, CachedFile>();
  private baseline = new Map<string, WorkspaceFile>();

  constructor(
    workspaceRoot: string,
    private readonly recorder: AgentTraceRecorder,
  ) {
    this.root = fs.realpathSync(workspaceRoot);
  }

  capture(phase: "baseline" | "checkpoint" | "final"): void {
    try {
      this.captureSnapshot(phase);
    } catch (error) {
      this.recorder.record({
        component: "workspace",
        type:
          phase === "baseline"
            ? "workspace_baseline_captured"
            : "workspace_diff_captured",
        payload: {
          phase,
          failure: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private captureSnapshot(phase: "baseline" | "checkpoint" | "final"): void {
    const { paths, scope } = listWorkspaceFiles(this.root);
    const current = new Map<string, WorkspaceFile>();
    const nextCache = new Map<string, CachedFile>();
    for (const relativePath of paths) {
      const file = this.captureFile(relativePath, nextCache);
      if (file) current.set(relativePath, file);
    }
    this.cache = nextCache;
    const omissions = [...current.values()].filter(
      (file) => file.omittedReason,
    );
    const value =
      phase === "baseline"
        ? { workspaceRoot: this.root, scope, files: [...current.values()] }
        : {
            workspaceRoot: this.root,
            scope,
            phase,
            changes: this.changesFromBaseline(current),
          };
    const material = this.recorder.captureMaterial?.(value);
    this.recorder.record(
      {
        component: "workspace",
        type:
          phase === "baseline"
            ? "workspace_baseline_captured"
            : "workspace_diff_captured",
        payload: {
          phase,
          scope,
          fileCount: current.size,
          omissionCount: omissions.length,
          material,
        },
      },
      { durable: true },
    );
    if (phase === "baseline") this.baseline = current;
  }

  private captureFile(
    relativePath: string,
    nextCache: Map<string, CachedFile>,
  ): WorkspaceFile | undefined {
    const absolutePath = path.resolve(this.root, relativePath);
    if (!absolutePath.startsWith(`${this.root}${path.sep}`)) return undefined;
    if (sensitivePath(relativePath))
      return {
        path: relativePath,
        sizeBytes: 0,
        omittedReason: "sensitive_path",
      };
    try {
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (!stat.isFile())
        return {
          path: relativePath,
          sizeBytes: 0,
          omittedReason: "not_a_regular_file",
        };
      if (!fs.realpathSync(absolutePath).startsWith(`${this.root}${path.sep}`))
        return {
          path: relativePath,
          sizeBytes: 0,
          omittedReason: "outside_workspace",
        };
      return this.captureRegularFile(
        relativePath,
        absolutePath,
        stat,
        nextCache,
      );
    } catch {
      return { path: relativePath, sizeBytes: 0, omittedReason: "read_failed" };
    }
  }

  private captureRegularFile(
    relativePath: string,
    absolutePath: string,
    stat: fs.BigIntStats,
    nextCache: Map<string, CachedFile>,
  ): WorkspaceFile {
    const cached = this.cache.get(relativePath);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeNs === stat.mtimeNs &&
      cached.ctimeNs === stat.ctimeNs
    ) {
      nextCache.set(relativePath, cached);
      return cached.file;
    }
    const bytes = fs.readFileSync(absolutePath);
    const material = this.recorder.captureMaterial?.(bytes);
    const file: WorkspaceFile = {
      path: relativePath,
      sizeBytes: bytes.length,
      ...(material
        ? { material }
        : { omittedReason: "material_capture_failed" }),
    };
    nextCache.set(relativePath, {
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      file,
    });
    return file;
  }

  private changesFromBaseline(current: Map<string, WorkspaceFile>) {
    const changes: Array<{
      path: string;
      change: "added" | "modified" | "deleted";
      file?: WorkspaceFile;
    }> = [];
    for (const [filePath, file] of current) {
      const before = this.baseline.get(filePath);
      if (workspaceFileChanged(before, file)) {
        changes.push({
          path: filePath,
          change: before ? "modified" : "added",
          file,
        });
      }
    }
    for (const filePath of this.baseline.keys()) {
      if (!current.has(filePath))
        changes.push({ path: filePath, change: "deleted" });
    }
    return changes;
  }
}

function workspaceFileChanged(
  before: WorkspaceFile | undefined,
  after: WorkspaceFile,
): boolean {
  return (
    !before ||
    before.material?.sha256 !== after.material?.sha256 ||
    before.omittedReason !== after.omittedReason
  );
}

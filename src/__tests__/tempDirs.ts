import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function createTempDirTracker(): {
  makeTempDir: (prefix: string) => string;
  cleanupTempDirs: () => void;
} {
  const tempDirs: string[] = [];

  return {
    makeTempDir(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    cleanupTempDirs(): void {
      for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

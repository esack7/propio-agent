import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function makeWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content = "test",
): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

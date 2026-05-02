import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AttachmentResolver } from "../attachmentResolver.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "propio-attachments-"));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

describe("AttachmentResolver", () => {
  it("resolves files and directories into synthetic tool results", async () => {
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "docs/notes.txt", "one\ntwo\nthree\nfour");
    writeFile(workspaceRoot, "docs/sub/child.txt", "child");

    const resolver = new AttachmentResolver({
      cwd: workspaceRoot,
      homeDir: os.homedir(),
    });

    const attachments = await resolver.resolveText(
      "@docs/notes.txt#L2-3 and @docs/sub",
    );

    expect(attachments).toHaveLength(2);
    expect(attachments[0].toolCall.function.name).toBe("read");
    expect(attachments[0].toolResult.status).toBe("success");
    expect(attachments[0].toolResult.rawContent).toContain("two");
    expect(attachments[0].toolResult.rawContent).toContain("three");
    expect(attachments[1].toolCall.function.name).toBe("ls");
    expect(attachments[1].toolResult.rawContent).toContain("file: child.txt");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("returns non-fatal error results for missing and binary files", async () => {
    const workspaceRoot = makeWorkspace();
    writeFile(workspaceRoot, "bin/data.bin", "\u0000binary");

    const resolver = new AttachmentResolver({
      cwd: workspaceRoot,
      homeDir: os.homedir(),
    });

    const attachments = await resolver.resolveText(
      "@missing.txt @bin/data.bin",
    );

    expect(attachments).toHaveLength(2);
    expect(attachments[0].toolResult.status).toBe("error");
    expect(attachments[0].toolResult.rawContent).toContain("not found");
    expect(attachments[1].toolResult.status).toBe("error");
    expect(attachments[1].toolResult.rawContent).toContain("binary file");

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

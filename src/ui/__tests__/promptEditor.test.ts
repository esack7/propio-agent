import * as fs from "fs";
import { openPromptEditor } from "../promptEditor.js";

describe("openPromptEditor", () => {
  it("prefers VISUAL over EDITOR and normalizes CRLF output", () => {
    const seenCommands: string[] = [];
    let capturedFilePath = "";

    const result = openPromptEditor({
      buffer: "draft",
      workspaceRoot: process.cwd(),
      env: {
        VISUAL: "nano",
        EDITOR: "vim",
      },
      runEditor: ({ command, filePath }) => {
        seenCommands.push(command);
        capturedFilePath = filePath;
        fs.writeFileSync(filePath, "edited\r\ncontent", "utf8");
        return { status: 0, signal: null };
      },
    });

    expect(seenCommands).toEqual(["nano"]);
    expect(result).toEqual({
      status: "edited",
      buffer: "edited\ncontent",
    });
    expect(fs.existsSync(capturedFilePath)).toBe(false);
  });

  it("falls back to EDITOR when VISUAL is unset", () => {
    const seenCommands: string[] = [];

    const result = openPromptEditor({
      buffer: "draft",
      workspaceRoot: process.cwd(),
      env: {
        EDITOR: "vim",
      },
      runEditor: ({ command, filePath }) => {
        seenCommands.push(command);
        fs.writeFileSync(filePath, "updated", "utf8");
        return { status: 0, signal: null };
      },
    });

    expect(seenCommands).toEqual(["vim"]);
    expect(result).toEqual({
      status: "edited",
      buffer: "updated",
    });
  });

  it("returns a missing-editor status when no editor is configured", () => {
    const result = openPromptEditor({
      buffer: "draft",
      workspaceRoot: process.cwd(),
      env: {},
    });

    expect(result).toEqual({
      status: "missing",
      buffer: "draft",
      message: "Editor unavailable. Set VISUAL or EDITOR.",
    });
  });

  it("preserves the original buffer when the editor fails", () => {
    let capturedFilePath = "";

    const result = openPromptEditor({
      buffer: "draft",
      workspaceRoot: process.cwd(),
      env: {
        VISUAL: "nano",
      },
      runEditor: ({ filePath }) => {
        capturedFilePath = filePath;
        return { status: 1, signal: null };
      },
    });

    expect(result).toEqual({
      status: "failed",
      buffer: "draft",
      message: "Editor exited with code 1.",
    });
    expect(fs.existsSync(capturedFilePath)).toBe(false);
  });
});

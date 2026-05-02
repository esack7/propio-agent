import { MentionParser } from "../mentionParser.js";

describe("MentionParser", () => {
  it("parses unquoted, quoted, and ranged mentions while deduping repeats", () => {
    const parser = new MentionParser();
    const mentions = parser.parse(
      'Please read @src/app.ts, @"docs/my file.md"#L10-20, @README.md#heading, and @src/app.ts again.',
    );

    expect(mentions).toEqual([
      { raw: "@src/app.ts", path: "src/app.ts", quoted: false },
      {
        raw: '@"docs/my file.md"#L10-20',
        path: "docs/my file.md",
        quoted: true,
        range: { startLine: 10, endLine: 20 },
      },
      { raw: "@README.md#heading", path: "README.md", quoted: false },
    ]);
  });

  it("keeps malformed quoted mentions permissive", () => {
    const parser = new MentionParser();
    const mentions = parser.parse('Try @"docs/broken path');

    expect(mentions).toEqual([
      { raw: '@"docs/broken path', path: "docs/broken path", quoted: true },
    ]);
  });

  it("ignores a bare stray @", () => {
    const parser = new MentionParser();

    expect(parser.parse("@")).toEqual([]);
    expect(parser.parse("hello @")).toEqual([]);
  });

  it("ignores clearly non-file @ mentions", () => {
    const parser = new MentionParser();
    const mentions = parser.parse(
      "Talk to @agent-code-reviewer or @github:repo/issues/123, but read @src/app.ts.",
    );

    expect(mentions).toEqual([
      { raw: "@src/app.ts", path: "src/app.ts", quoted: false },
    ]);
  });
});

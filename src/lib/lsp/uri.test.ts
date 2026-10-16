import { describe, it, expect } from "vitest";
import { pathToFileUri, fileUriToPath } from "./uri";

describe("lsp uri", () => {
  it("encodes_spaces_and_reserved_chars_per_segment", () => {
    expect(pathToFileUri("/Users/a/My Project/x#1.ts")).toBe("file:///Users/a/My%20Project/x%231.ts");
  });

  it("round_trips", () => {
    for (const p of ["/a/b.ts", "/Users/a/My Project/x#1.ts", "/tmp/caf\u00e9/%.rs", "/q/what?.ts"]) {
      expect(fileUriToPath(pathToFileUri(p))).toBe(p);
    }
  });

  it("decodes_server_encoded_uris", () => {
    expect(fileUriToPath("file:///Users/a/My%20Project/x.ts")).toBe("/Users/a/My Project/x.ts");
  });

  it("leaves_non_file_uris_and_plain_paths_alone", () => {
    expect(fileUriToPath("/already/a/path.ts")).toBe("/already/a/path.ts");
    expect(fileUriToPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });

  it("tolerates_malformed_escapes", () => {
    expect(fileUriToPath("file:///bad/%E0%A4%A")).toBe("/bad/%E0%A4%A");
  });
});

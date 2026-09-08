import type { ChangedFile, GithubInstallationClient } from "@pr-review/github";
import type { FindingPatch, ReviewFinding } from "@pr-review/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_PATCHED_FILES,
  MAX_PATCHED_LINES,
  verifyPatches,
} from "./validate-patches.js";

const headSha = "f00dcafe";

/** src/service.ts: line 9 is context, lines 10-12 are added. */
const servicePatch = [
  "@@ -9,1 +9,4 @@ export function service() {",
  " const context9 = true;",
  "+const added10 = true;",
  "+const added11 = true;",
  "+const added12 = true;",
].join("\n");

const serviceContents = [
  "line1",
  "line2",
  "line3",
  "line4",
  "line5",
  "line6",
  "line7",
  "line8",
  "const context9 = true;",
  "const added10 = true;",
  "const added11 = true;",
  "const added12 = true;",
  "",
].join("\n");

const changedFiles: ChangedFile[] = [
  {
    filename: "src/service.ts",
    status: "modified",
    additions: 3,
    deletions: 0,
    patch: servicePatch,
  },
];

function patch(overrides: Partial<FindingPatch> = {}): FindingPatch {
  return {
    startLine: 10,
    endLine: 10,
    expected: "const added10 = true;",
    replacement: "const added10 = false;",
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "src/service.ts",
    line: 10,
    category: "correctness",
    severity: "medium",
    title: "Wrong flag",
    explanation: "The flag is inverted.",
    confidence: 0.9,
    patch: patch(),
    ...overrides,
  };
}

function makeDeps(contents: Record<string, string> = {}) {
  const files: Record<string, string> = {
    "src/service.ts": serviceContents,
    ...contents,
  };
  const getFileContents = vi.fn(async ({ path }: { path: string }) => {
    const found = files[path];
    if (found === undefined) {
      throw new Error(`Not Found: ${path}`);
    }
    return found;
  });
  const client = { getFileContents } as unknown as GithubInstallationClient;
  return { client, owner: "octo-org", repo: "example-service", headSha, getFileContents };
}

describe("verifyPatches", () => {
  it("keeps a patch whose expected text matches the file", async () => {
    const result = await verifyPatches([finding()], changedFiles, makeDeps());

    expect(result.patchCount).toBe(1);
    expect(result.findings[0]?.patch).toEqual(patch());
    expect(result.files).toEqual([
      {
        path: "src/service.ts",
        content: serviceContents.replace(
          "const added10 = true;",
          "const added10 = false;",
        ),
      },
    ]);
  });

  it("drops a patch whose expected text does not match, keeping the finding", async () => {
    const stale = finding({ patch: patch({ expected: "const added10 = TRUE;" }) });

    const result = await verifyPatches([stale], changedFiles, makeDeps());

    expect(result.patchCount).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patch).toBeUndefined();
    expect(result.findings[0]?.title).toBe("Wrong flag");
  });

  it("drops a patch whose range runs past the end of the file", async () => {
    const overrun = finding({
      patch: patch({ startLine: 12, endLine: 99, expected: "const added12 = true;" }),
    });

    const result = await verifyPatches([overrun], changedFiles, makeDeps());

    expect(result.patchCount).toBe(0);
  });

  it("drops a patch that touches no line the pull request adds", async () => {
    const outside = finding({
      line: 10,
      patch: patch({ startLine: 9, endLine: 9, expected: "const context9 = true;" }),
    });

    const result = await verifyPatches([outside], changedFiles, makeDeps());

    expect(result.patchCount).toBe(0);
  });

  it("drops a patch on a file the pull request does not change", async () => {
    const elsewhere = finding({ file: "src/untouched.ts" });

    const result = await verifyPatches([elsewhere], changedFiles, makeDeps());

    expect(result.patchCount).toBe(0);
  });

  it("keeps only the strongest of two patches whose ranges overlap", async () => {
    const weak = finding({
      severity: "low",
      title: "Weak",
      patch: patch({ startLine: 10, endLine: 11, expected: "const added10 = true;\nconst added11 = true;" }),
    });
    const strong = finding({ severity: "high", title: "Strong" });

    const result = await verifyPatches([weak, strong], changedFiles, makeDeps());

    expect(result.patchCount).toBe(1);
    expect(
      result.findings.find((f) => f.title === "Strong")?.patch,
    ).toBeDefined();
    expect(result.findings.find((f) => f.title === "Weak")?.patch).toBeUndefined();
  });

  it("applies two non-overlapping patches to one file", async () => {
    const first = finding({ title: "First" });
    const second = finding({
      title: "Second",
      line: 12,
      patch: patch({
        startLine: 12,
        endLine: 12,
        expected: "const added12 = true;",
        replacement: "const added12 = false;",
      }),
    });

    const result = await verifyPatches([first, second], changedFiles, makeDeps());

    expect(result.patchCount).toBe(2);
    expect(result.files[0]?.content).toContain("const added10 = false;");
    expect(result.files[0]?.content).toContain("const added11 = true;");
    expect(result.files[0]?.content).toContain("const added12 = false;");
  });

  it("deletes the range when the replacement is empty", async () => {
    const deletion = finding({ patch: patch({ replacement: "" }) });

    const result = await verifyPatches([deletion], changedFiles, makeDeps());

    expect(result.files[0]?.content).not.toContain("added10");
    expect(result.files[0]?.content).toContain("const added11 = true;");
  });

  it("keeps the file's trailing newline", async () => {
    const result = await verifyPatches([finding()], changedFiles, makeDeps());

    expect(result.files[0]?.content.endsWith("\n")).toBe(true);
  });

  it("accepts an expected block that carries its trailing newline", async () => {
    const withNewline = finding({
      patch: patch({ expected: "const added10 = true;\n" }),
    });

    const result = await verifyPatches([withNewline], changedFiles, makeDeps());

    expect(result.patchCount).toBe(1);
  });

  it("drops a patch when the file cannot be read", async () => {
    const deps = makeDeps();
    deps.getFileContents.mockRejectedValue(new Error("Not Found"));

    const result = await verifyPatches([finding()], changedFiles, deps);

    expect(result.patchCount).toBe(0);
    expect(result.findings[0]?.patch).toBeUndefined();
  });

  it("reads each patched file once, however many patches it carries", async () => {
    const deps = makeDeps();
    const second = finding({
      title: "Second",
      line: 12,
      patch: patch({
        startLine: 12,
        endLine: 12,
        expected: "const added12 = true;",
      }),
    });

    await verifyPatches([finding(), second], changedFiles, deps);

    expect(deps.getFileContents).toHaveBeenCalledTimes(1);
  });

  it("leaves a finding without a patch untouched", async () => {
    const plain = finding({ patch: undefined });

    const result = await verifyPatches([plain], changedFiles, makeDeps());

    expect(result.findings[0]).toEqual(plain);
    expect(result.patchCount).toBe(0);
  });

  it("caps the number of patched files", async () => {
    const files: ChangedFile[] = [];
    const contents: Record<string, string> = {};
    const findings: ReviewFinding[] = [];
    for (let index = 0; index < MAX_PATCHED_FILES + 2; index += 1) {
      const path = `src/file${index}.ts`;
      files.push({
        filename: path,
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: ["@@ -1,0 +1,1 @@", "+const added1 = true;"].join("\n"),
      });
      contents[path] = "const added1 = true;\n";
      findings.push(
        finding({
          file: path,
          line: 1,
          title: `Finding ${index}`,
          patch: patch({
            startLine: 1,
            endLine: 1,
            expected: "const added1 = true;",
            replacement: "const added1 = false;",
          }),
        }),
      );
    }

    const result = await verifyPatches(findings, files, makeDeps(contents));

    expect(result.files).toHaveLength(MAX_PATCHED_FILES);
    expect(result.patchCount).toBe(MAX_PATCHED_FILES);
  });

  it("caps the number of replaced lines", async () => {
    const size = MAX_PATCHED_LINES + 1;
    const lines = Array.from({ length: size }, (_v, i) => `const added${i + 1} = true;`);
    const patchText = [
      `@@ -1,0 +1,${size} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    const files: ChangedFile[] = [
      { filename: "src/big.ts", status: "added", additions: size, deletions: 0, patch: patchText },
    ];
    const oversized = finding({
      file: "src/big.ts",
      line: 1,
      patch: patch({
        startLine: 1,
        endLine: size,
        expected: lines.join("\n"),
        replacement: "const added1 = false;",
      }),
    });

    const result = await verifyPatches(
      [oversized],
      files,
      makeDeps({ "src/big.ts": `${lines.join("\n")}\n` }),
    );

    expect(result.patchCount).toBe(0);
  });
});

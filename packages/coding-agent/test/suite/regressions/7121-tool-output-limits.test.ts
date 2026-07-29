import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindTool } from "../../../src/core/tools/find.ts";
import { truncateLine } from "../../../src/core/tools/truncate.ts";
import { createWriteTool } from "../../../src/core/tools/write.ts";

type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: { resultLimitReached?: number };
};

function getText(result: ToolResult): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("issue #7121 tool output limits", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-7121-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("reports the UTF-8 byte count after writing", async () => {
		const tool = createWriteTool(tempRoot);

		const result = await tool.execute("write", { path: "unicode.txt", content: "你好🙂" });

		expect(getText(result)).toBe("Successfully wrote 10 bytes to unicode.txt");
	});

	it("only reports the find result limit when more results exist", async () => {
		for (let index = 1; index <= 4; index++) {
			writeFileSync(join(tempRoot, `${index}.txt`), "");
		}
		const tool = createFindTool(tempRoot);

		const exactResult = (await tool.execute("find-exact", { pattern: "*.txt", limit: 4 })) as ToolResult;
		expect(exactResult.details?.resultLimitReached).toBeUndefined();
		expect(getText(exactResult)).not.toContain("results limit reached");

		const overflowResult = (await tool.execute("find-overflow", { pattern: "*.txt", limit: 3 })) as ToolResult;
		const outputPaths = getText(overflowResult)
			.split("\n")
			.filter((line) => line.length > 0 && !line.startsWith("["));
		expect(outputPaths).toHaveLength(3);
		expect(overflowResult.details?.resultLimitReached).toBe(3);
		expect(getText(overflowResult)).toContain("3 results limit reached");
	});

	it("only reports custom find operation limits when more results exist", async () => {
		const matches = Array.from({ length: 4 }, (_, index) => join(tempRoot, `${index + 1}.txt`));
		let available = matches.slice(0, 3);
		const tool = createFindTool(tempRoot, {
			operations: {
				exists: () => true,
				glob: (_pattern, _cwd, options) => available.slice(0, options.limit),
			},
		});

		const exactResult = (await tool.execute("find-exact", { pattern: "*.txt", limit: 3 })) as ToolResult;
		expect(exactResult.details?.resultLimitReached).toBeUndefined();

		available = matches;
		const overflowResult = (await tool.execute("find-overflow", { pattern: "*.txt", limit: 3 })) as ToolResult;
		const outputPaths = getText(overflowResult)
			.split("\n")
			.filter((line) => line.length > 0 && !line.startsWith("["));
		expect(outputPaths).toHaveLength(3);
		expect(overflowResult.details?.resultLimitReached).toBe(3);
	});

	it("does not split surrogate pairs when truncating a line", () => {
		expect(truncateLine("ab🙂cd", 3)).toEqual({
			text: "ab... [truncated]",
			wasTruncated: true,
		});
	});
});

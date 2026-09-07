import { describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";

interface CapturedPayload {
	fallbacks?: Array<{ model: string }>;
}

// Regression: #9294. Anthropic rejects Opus 4.8 as a Fable 5 fallback before inference starts.
describe("Anthropic Fable fallback models", () => {
	it("only allows Opus 5 for Fable 5 and preserves fallback pricing", () => {
		expect(getModel("anthropic", "claude-fable-5").compat?.allowedFallbackModels).toEqual([
			{
				provider: "anthropic",
				model: "claude-opus-5",
				cost: getModel("anthropic", "claude-opus-5").cost,
			},
		]);
	});

	it("does not add fallback targets to Fable 5.1", () => {
		expect(getModel("anthropic", "claude-fable-5-1").compat?.allowedFallbackModels).toBeUndefined();
	});

	describe.each([
		{ auth: "API key", apiKey: "test-key" },
		{ auth: "OAuth", apiKey: "sk-ant-oat-test-token" },
	])("$auth requests", ({ apiKey }) => {
		it.each([
			{ modelId: "claude-fable-5", fallbacks: [{ model: "claude-opus-5" }] },
			{ modelId: "claude-fable-5-1", fallbacks: undefined },
		] as const)("sends only supported fallbacks for $modelId at low effort", async ({ modelId, fallbacks }) => {
			let payload: CapturedPayload | undefined;
			const result = await stream(
				getModel("anthropic", modelId),
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{
					apiKey,
					thinkingEnabled: true,
					effort: "low",
					onPayload: (value) => {
						payload = value as CapturedPayload;
						throw new Error("payload captured");
					},
				},
			).result();

			expect(result.errorMessage).toBe("payload captured");
			expect(payload).toBeDefined();
			expect(payload?.fallbacks).toEqual(fallbacks);
		});
	});
});

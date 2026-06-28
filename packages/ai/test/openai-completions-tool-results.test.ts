import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

function buildToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		],
		isError: false,
		timestamp,
	};
}

function convertToolResult(content: ToolResultMessage["content"]): unknown {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	const model: Model<"openai-completions"> = {
		...baseModel,
		api: "openai-completions",
		input: ["text", "image"],
	};
	const context: Context = {
		messages: [
			{
				role: "toolResult",
				toolCallId: "tool-empty",
				toolName: "replace",
				content,
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
	const messages = convertMessages(model, context, compat);
	const toolMessage = messages.find((message) => message.role === "tool");
	if (!toolMessage || toolMessage.role !== "tool") {
		throw new Error("Expected tool message");
	}
	return toolMessage.content;
}

describe("openai-completions empty tool results", () => {
	it("does not use the attached-image hint for empty text when no image is attached", () => {
		expect(convertToolResult([{ type: "text", text: "" }])).toBe("");
	});

	it("does not use the attached-image hint for contentless results when no image is attached", () => {
		expect(convertToolResult([])).toBe("");
	});
});

describe("openai-completions tool result images", () => {
	it("uses the attached-image hint when text is empty and an image is attached", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "tool-empty-image",
					toolName: "replace",
					content: [
						{ type: "text", text: "" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((message) => message.role === "tool");
		expect(toolMessage?.content).toBe("(see attached image)");

		const imageMessage = messages.find((message) => message.role === "user" && Array.isArray(message.content));
		expect(imageMessage).toBeDefined();
		if (!imageMessage || imageMessage.role !== "user" || !Array.isArray(imageMessage.content)) {
			throw new Error("Expected user image message");
		}

		const imageParts = (imageMessage.content as Array<{ type?: string; image_url?: { url?: string } }>).filter(
			(part) => part?.type === "image_url",
		);
		expect(imageParts).toHaveLength(1);
		expect(imageParts[0].image_url?.url).toBe("data:image/png;base64,ZmFrZQ==");
	});

	it("batches tool-result images after consecutive tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context, compat);
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (imageMessage.content as Array<{ type?: string }>).filter(
			(part) => part?.type === "image_url",
		);
		expect(imageParts.length).toBe(2);
	});
});

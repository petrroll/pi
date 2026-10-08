import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { Credential, OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import type { Api, FetchFunction } from "../src/types.ts";

const oldToken = "tid=old;proxy-ep=proxy.enterprise.githubcopilot.com;";
const newToken = "tid=new;proxy-ep=proxy.business.githubcopilot.com;";
const credential: OAuthCredential = {
	type: "oauth",
	access: oldToken,
	refresh: "github-oauth-token",
	expires: Date.now() + 24 * 60 * 60_000,
};

function success(api: Api): Response {
	const events =
		api === "anthropic-messages"
			? [
					{ type: "message_start", message: { id: "test", usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				]
			: api === "openai-responses"
				? [
						{
							type: "response.completed",
							response: {
								id: "test",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						},
					]
				: [{ id: "test", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }];
	return new Response(
		events
			.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

async function setup(stored: Credential | undefined = credential) {
	const credentials = new InMemoryCredentialStore();
	if (stored) await credentials.modify("github-copilot", async () => stored);
	const provider = githubCopilotProvider();
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	models.setProvider(provider);
	const mint = vi.fn<FetchFunction>(async (url, init) => {
		const request = new Request(url, init);
		if (request.url === "https://api.github.com/copilot_internal/v2/token") {
			expect(request.headers.get("authorization")).toBe("Bearer github-oauth-token");
			return Response.json({ token: newToken, expires_at: Math.floor(Date.now() / 1000) + 86400 });
		}
		expect(request.url).toBe("https://api.business.githubcopilot.com/models");
		expect(request.headers.get("authorization")).toBe(`Bearer ${newToken}`);
		return Response.json({ data: [] });
	});
	vi.stubGlobal("fetch", mint);
	return { credentials, models, provider, mint };
}

afterEach(() => vi.unstubAllGlobals());

// #10238: exercise the real Copilot OAuth flow and all three SDK-backed HTTP APIs.
describe("GitHub Copilot rejected-token recovery", () => {
	for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
		for (const simple of [false, true]) {
			it.each([401, 403])(`${api} ${simple ? "simple" : "full"} recovers from %s`, async (status) => {
				const { models, provider, credentials, mint } = await setup();
				const model = provider.getModels().find((entry) => entry.api === api)!;
				expect(model).toBeDefined();
				const requests: Request[] = [];
				const fetch = vi.fn<FetchFunction>(async (url, init) => {
					const request = new Request(url, init);
					requests.push(request);
					if (requests.length === 1) return Response.json({ error: { message: "revoked" } }, { status });
					expect(request.url).toContain("https://api.business.githubcopilot.com/");
					expect(request.headers.get("authorization")).toBe(`Bearer ${newToken}`);
					return success(api);
				});
				const options = { fetch, maxRetries: 0, maxTokens: 64 };
				const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
				const stream = simple
					? models.streamSimple(model, context, options)
					: models.stream(model, context, options);
				const events: string[] = [];
				for await (const event of stream) events.push(event.type);
				const result = await stream.result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(events.filter((event) => event === "start")).toHaveLength(1);
				expect(events).not.toContain("error");
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(mint).toHaveBeenCalledTimes(2); // one mint, one account catalog fetch
				expect(await credentials.read("github-copilot")).toMatchObject({ access: newToken });
				expect(await requests[1].text()).toBe(await requests[0].text());
			});
		}
	}

	it.each(["explicit-key", "stored-key", "explicit-header", "disabled-policy"])(
		"does not refresh %s",
		async (kind) => {
			const { models, provider, mint } = await setup(
				kind === "stored-key" ? { type: "api_key", key: "stored" } : credential,
			);
			if (kind === "disabled-policy") provider.auth.oauth!.refreshOnStatus = undefined;
			const model = provider.getModels().find((entry) => entry.api === "openai-completions")!;
			const fetch = vi.fn<FetchFunction>(async () =>
				Response.json({ error: { message: "forbidden" } }, { status: 403 }),
			);
			const result = await models.completeSimple(
				model,
				{ messages: [] },
				{
					fetch,
					maxRetries: 0,
					apiKey: kind === "explicit-key" ? "explicit" : undefined,
					headers: kind === "explicit-header" ? { authorization: "Bearer explicit" } : undefined,
				},
			);
			expect(result.stopReason).toBe("error");
			expect(fetch).toHaveBeenCalledOnce();
			expect(mint).not.toHaveBeenCalled();
		},
	);

	it("does not turn a failed refresh into a retryable SDK connection error", async () => {
		const { models, provider, mint, credentials } = await setup();
		mint.mockImplementation(async () => Response.json({ error: "bad credentials" }, { status: 401 }));
		const model = provider.getModels().find((entry) => entry.api === "openai-completions")!;
		const fetch = vi.fn<FetchFunction>(async () =>
			Response.json({ error: { message: "original forbidden" } }, { status: 403 }),
		);
		const result = await models.completeSimple(model, { messages: [] }, { fetch });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("original forbidden");
		expect(fetch).toHaveBeenCalledOnce();
		expect(mint).toHaveBeenCalledOnce();
		expect(await credentials.read("github-copilot")).toEqual(credential);
	});

	it("surfaces a second rejection without another refresh", async () => {
		const { models, provider, mint } = await setup();
		const model = provider.getModels().find((entry) => entry.api === "openai-completions")!;
		const fetch = vi.fn<FetchFunction>(async () =>
			Response.json({ error: { message: "forbidden" } }, { status: 403 }),
		);
		const result = await models.completeSimple(model, { messages: [] }, { fetch });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("forbidden");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(mint).toHaveBeenCalledTimes(2);
	});
});

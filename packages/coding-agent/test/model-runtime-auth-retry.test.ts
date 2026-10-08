import { type FetchFunction, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const oldToken = "tid=old;proxy-ep=proxy.enterprise.githubcopilot.com;";
const newToken = "tid=new;proxy-ep=proxy.enterprise.githubcopilot.com;";

afterEach(() => vi.unstubAllGlobals());

// #10238: coding-agent prepares requests separately from pi-ai's Models implementation.
describe("ModelRuntime Copilot auth recovery", () => {
	it.each([false, true])("refreshes rejected OAuth in the %s simple request path", async (simple) => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access: oldToken,
			refresh: "github-token",
			expires: Date.now() + 86400_000,
		}));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const model = runtime.getModels("github-copilot").find((entry) => entry.api === "openai-completions")!;
		const mint = vi.fn<FetchFunction>(async (url, init) => {
			const request = new Request(url, init);
			if (request.url.endsWith("/copilot_internal/v2/token")) {
				expect(request.headers.get("authorization")).toBe("Bearer github-token");
				return Response.json({ token: newToken, expires_at: Math.floor(Date.now() / 1000) + 86400 });
			}
			expect(request.url).toBe("https://api.enterprise.githubcopilot.com/models");
			return Response.json({ data: [] });
		});
		vi.stubGlobal("fetch", mint);
		const fetch = vi.fn<FetchFunction>(async (url, init) => {
			const request = new Request(url, init);
			if (request.headers.get("authorization") === `Bearer ${oldToken}`) {
				return Response.json({ error: { message: "forbidden" } }, { status: 403 });
			}
			expect(request.headers.get("authorization")).toBe(`Bearer ${newToken}`);
			expect(request.headers.get("x-transformed")).toBe("yes");
			return new Response(
				`data: ${JSON.stringify({
					id: "test",
					choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
				})}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const transformHeaders = vi.fn(async (headers) => ({ ...headers, "x-transformed": "yes" }));
		const options = { fetch, transformHeaders, maxRetries: 0 };
		const result = simple
			? await runtime.completeSimple(model, { messages: [] }, options)
			: await runtime.complete(model, { messages: [] }, options);
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(mint).toHaveBeenCalledTimes(2);
		expect(transformHeaders).toHaveBeenCalledOnce();
		expect(await credentials.read("github-copilot")).toMatchObject({ access: newToken });
	});
});

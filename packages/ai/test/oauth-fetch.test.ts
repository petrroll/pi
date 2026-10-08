import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { oauthRetryFetch } from "../src/auth/oauth-fetch.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import type { FetchFunction } from "../src/types.ts";

const baseUrl = "https://api.enterprise.githubcopilot.com";
const original: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "github-token",
	expires: Date.now() + 24 * 60 * 60_000,
};

async function setup(fetch: FetchFunction, overrides: Partial<OAuthAuth> = {}) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("copilot", async () => ({ ...original }));
	const refresh = vi.fn(async (credential: OAuthCredential) => ({ ...credential, access: "new-access" }));
	const oauth: OAuthAuth = {
		name: "Copilot",
		refreshOnStatus: [401, 403],
		login: async () => original,
		refresh,
		toAuth: async (credential) => ({ apiKey: credential.access, baseUrl }),
		...overrides,
	};
	const createFetch = (signal?: AbortSignal) =>
		oauthRetryFetch({ credentials, providerId: "copilot", oauth, apiKey: original.access, baseUrl, fetch, signal });
	return { credentials, oauth, refresh, createFetch };
}

function request() {
	return new Request(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${original.access}`, "content-type": "application/json", "x-test": "kept" },
		body: JSON.stringify({ messages: ["hello"] }),
	});
}

// Regression coverage for #10238: a token can be revoked well before expires_at.
describe("OAuth HTTP auth recovery", () => {
	it.each([401, 403])("refreshes once on %s and replays the body and headers", async (status) => {
		const requests: Request[] = [];
		const cancelled = vi.fn();
		const fetch = vi.fn<FetchFunction>(async (url, init) => {
			requests.push(new Request(url, init));
			return requests.length === 1
				? new Response(new ReadableStream({ cancel: cancelled }), { status })
				: new Response("ok");
		});
		const { createFetch, credentials, refresh } = await setup(fetch);
		const response = await createFetch()(request());

		expect(await response.text()).toBe("ok");
		expect(refresh).toHaveBeenCalledOnce();
		expect(cancelled).toHaveBeenCalledOnce();
		expect(await credentials.read("copilot")).toMatchObject({ access: "new-access", refresh: "github-token" });
		expect(requests.map((entry) => entry.headers.get("authorization"))).toEqual([
			"Bearer old-access",
			"Bearer new-access",
		]);
		for (const entry of requests) {
			expect(entry.method).toBe("POST");
			expect(entry.headers.get("x-test")).toBe("kept");
			expect(await entry.json()).toEqual({ messages: ["hello"] });
		}
	});

	it("uses the refreshed endpoint and token on subsequent transport retries", async () => {
		const requests: Request[] = [];
		const fetch = vi.fn<FetchFunction>(async (url, init) => {
			requests.push(new Request(url, init));
			return new Response("", { status: requests.length === 1 ? 403 : 200 });
		});
		const { createFetch, refresh } = await setup(fetch, {
			toAuth: async (credential) => ({
				apiKey: credential.access,
				baseUrl: "https://api.business.githubcopilot.com/",
			}),
		});
		const wrapped = createFetch();
		await wrapped(request());
		await wrapped(request());
		expect(refresh).toHaveBeenCalledOnce();
		for (const entry of requests.slice(1)) {
			expect(entry.url).toBe("https://api.business.githubcopilot.com/chat/completions");
			expect(entry.headers.get("authorization")).toBe("Bearer new-access");
		}
	});

	it.each([401, 403])("returns a persistent %s after exactly one refresh and replay", async (status) => {
		const fetch = vi.fn<FetchFunction>(async () => new Response("permission denied", { status }));
		const { createFetch, refresh } = await setup(fetch);
		const response = await createFetch()(request());
		expect(response.status).toBe(status);
		expect(await response.text()).toBe("permission denied");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("preserves the original HTTP error and credential when refresh fails", async () => {
		const fetch = vi.fn<FetchFunction>(async () => new Response("original forbidden", { status: 403 }));
		const refresh = vi.fn(async () => {
			throw new Error("revoked GitHub token");
		});
		const { createFetch, credentials } = await setup(fetch, { refresh });
		const response = await createFetch()(request());
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("original forbidden");
		expect(fetch).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		expect(await credentials.read("copilot")).toEqual(original);
	});

	it("coalesces simultaneous rejections under the credential-store lock", async () => {
		const allStarted = Promise.withResolvers<void>();
		let oldRequests = 0;
		const fetch = vi.fn<FetchFunction>(async (url, init) => {
			if (new Request(url, init).headers.get("authorization") === "Bearer new-access") return new Response("ok");
			if (++oldRequests === 3) allStarted.resolve();
			await allStarted.promise;
			return new Response("forbidden", { status: 403 });
		});
		const { createFetch, refresh } = await setup(fetch);
		const responses = await Promise.all([
			createFetch()(request()),
			createFetch()(request()),
			createFetch()(request()),
		]);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
		expect(refresh).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	it.each(["logout", "api-key", "new-oauth"])("respects a concurrent %s", async (change) => {
		const fetch = vi.fn<FetchFunction>(async () => {
			if (fetch.mock.calls.length > 1) return new Response("ok");
			if (change === "logout") await state.credentials.delete("copilot");
			else
				await state.credentials.modify("copilot", async () =>
					change === "api-key" ? { type: "api_key", key: "manual" } : { ...original, access: "new-login" },
				);
			return new Response("forbidden", { status: 403 });
		});
		const state = await setup(fetch);
		const response = await state.createFetch()(request());
		expect(state.refresh).not.toHaveBeenCalled();
		expect(response.status).toBe(change === "new-oauth" ? 200 : 403);
		expect(fetch).toHaveBeenCalledTimes(change === "new-oauth" ? 2 : 1);
	});

	it.each([200, 400, 404, 429, 500])("does not refresh on %s", async (status) => {
		const fetch = vi.fn<FetchFunction>(async () => new Response("body", { status }));
		const { createFetch, refresh } = await setup(fetch);
		expect((await createFetch()(request())).status).toBe(status);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each(["header", "endpoint", "lookalike-endpoint"])("does not replace caller-owned auth: %s", async (kind) => {
		const fetch = vi.fn<FetchFunction>(async (url, init) => {
			expect(await new Request(url, init).json()).toEqual({ messages: ["hello"] });
			return new Response("forbidden", { status: 403 });
		});
		const { createFetch, refresh } = await setup(fetch);
		const originalRequest = request();
		const changed =
			kind === "header"
				? new Request(originalRequest, { headers: { authorization: "Bearer explicit" } })
				: new Request(
						kind === "endpoint" ? "https://other.test/chat" : `${baseUrl}.other.test/chat`,
						originalRequest,
					);
		expect((await createFetch()(changed)).status).toBe(403);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("does not replay an accepted response whose body fails", async () => {
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("401 inside the stream"));
						},
					}),
				),
		);
		const { createFetch, refresh } = await setup(fetch);
		const response = await createFetch()(request());
		await expect(response.text()).rejects.toThrow("401 inside the stream");
		expect(fetch).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
	});

	it("does not refresh after cancellation while waiting for the store lock", async () => {
		const rejected = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetch = vi.fn<FetchFunction>(async () => {
			rejected.resolve();
			return new Response("forbidden", { status: 403 });
		});
		const { credentials, createFetch, refresh } = await setup(fetch);
		const holding = credentials.modify("copilot", async () => {
			await release.promise;
			return undefined;
		});
		const controller = new AbortController();
		const pending = createFetch(controller.signal)(request());
		await rejected.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		release.resolve();
		await holding;
		// A queued mutation must be skipped after the holder releases the lock.
		await credentials.modify("copilot", async () => undefined);
		expect(refresh).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("cancels promptly during refresh but persists the rotated credential", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const controller = new AbortController();
		const fetch = vi.fn<FetchFunction>(async () => new Response("forbidden", { status: 403 }));
		const { createFetch, credentials } = await setup(fetch, {
			refresh: async (credential, signal) => {
				started.resolve();
				await finish.promise;
				expect(signal.aborted).toBe(false);
				return { ...credential, access: "rotated-access", refresh: "rotated-refresh" };
			},
		});
		const pending = createFetch(controller.signal)(request());
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		finish.resolve();
		await vi.waitFor(async () => {
			expect(await credentials.read("copilot")).toMatchObject({
				access: "rotated-access",
				refresh: "rotated-refresh",
			});
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});

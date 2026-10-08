import type { FetchFunction } from "../types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { refreshStoredOAuthCredential } from "./resolve.ts";
import type { CredentialStore, ModelAuth, OAuthAuth } from "./types.ts";

/** One auth recovery per logical request, before an HTTP body reaches an API adapter. */
export function oauthRetryFetch(input: {
	credentials: CredentialStore;
	providerId: string;
	oauth: OAuthAuth;
	apiKey: string;
	baseUrl: string;
	fetch?: FetchFunction;
	signal?: AbortSignal;
}): FetchFunction {
	const fetch = input.fetch ?? globalThis.fetch;
	const baseUrl = input.baseUrl.replace(/\/$/, "");
	let attempted = false;
	let refreshedAuth: ModelAuth | undefined;

	return async (url, init) => {
		const requestUrl = url instanceof Request ? url.url : String(url);
		const requestHeaders = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
		// Check before constructing a Request, which consumes an input Request's body.
		// Do not replace explicit auth headers or send refreshed credentials to a
		// different endpoint (including auxiliary requests made by an adapter).
		if (!requestUrl.startsWith(`${baseUrl}/`) || requestHeaders.get("authorization") !== `Bearer ${input.apiKey}`) {
			return fetch(url, init);
		}
		const request = new Request(url, init);
		const signal = input.signal ? AbortSignal.any([input.signal, request.signal]) : request.signal;
		const authorizedRequest = (auth: ModelAuth): Request => {
			const headers = new Headers(request.headers);
			headers.set("authorization", `Bearer ${auth.apiKey}`);
			const nextUrl = auth.baseUrl
				? auth.baseUrl.replace(/\/$/, "") + request.url.slice(baseUrl.length)
				: request.url;
			return new Request(nextUrl, new Request(request.clone(), { headers, signal }));
		};

		// Ordinary SDK retries after recovery must also use the refreshed token.
		const response = await fetch(refreshedAuth ? authorizedRequest(refreshedAuth) : request.clone());
		if (attempted || !input.oauth.refreshOnStatus?.some((status) => status === response.status)) return response;
		attempted = true;

		try {
			const credential = await raceWithAbortSignal(
				refreshStoredOAuthCredential(
					input.credentials,
					input.providerId,
					input.oauth,
					(current) => current.access === input.apiKey,
					signal,
				),
				signal,
			);
			// Logout or replacement with an API key must not resurrect OAuth auth.
			if (!credential) return response;
			const auth = await raceWithAbortSignal(input.oauth.toAuth(credential), signal);
			if (!auth.apiKey) return response;
			refreshedAuth = auth;
		} catch {
			// Preserve the API's original authorization error if recovery fails.
			// Throwing here would make SDKs treat it as a retryable connection error.
			if (signal.aborted) {
				await response.body?.cancel();
				signal.throwIfAborted();
			}
			return response;
		}

		await response.body?.cancel();
		signal.throwIfAborted();
		return fetch(authorizedRequest(refreshedAuth));
	};
}

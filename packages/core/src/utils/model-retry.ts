/**
 * Provider retry metadata shared by transport retries and durable memory jobs.
 * Only structural status/header fields establish a deadline; prose never does.
 *
 * The installed AI SDK wraps a provider failure in a `RetryError` envelope once
 * its own retries exhaust; the envelope's top node carries no status and no
 * headers — the 429 and its Retry-After live on the wrapped `APICallError`.
 * These classifiers therefore read the same bounded cause/lastError/errors
 * graph as the model-error classifiers, and never a message substring.
 */

/**
 * Bounded walk of the wrapped provider-error graph: `.cause`, the AI SDK
 * `RetryError` envelope's `.lastError` / `.errors[]`. Only object nodes are
 * traversed, bounded like the model-error chain walk.
 */
function* retryEvidenceNodes(error: unknown): Generator<object> {
	const seen = new Set<unknown>();
	const stack: unknown[] = [error];
	while (stack.length > 0 && seen.size < 12) {
		const node = stack.pop();
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		yield node;
		const wrapped = node as {
			cause?: unknown;
			lastError?: unknown;
			errors?: unknown;
		};
		if (wrapped.cause !== undefined) stack.push(wrapped.cause);
		if (wrapped.lastError !== undefined) stack.push(wrapped.lastError);
		if (Array.isArray(wrapped.errors)) stack.push(...wrapped.errors);
	}
}

/**
 * Read the provider's retry delay once for both retry admission and cooldowns.
 * The millisecond header takes precedence over Retry-After seconds/date, matching
 * the SDK transport contract. Invalid values fall through to the other header;
 * missing or invalid hints leave the bounded exponential policy in control.
 */
export function providerRetryAfterMs(
	error: unknown,
	now = Date.now(),
): number | undefined {
	const headers = (error as { responseHeaders?: unknown } | undefined)
		?.responseHeaders;
	if (!headers || typeof headers !== "object") return undefined;
	let milliseconds: string | undefined;
	let secondsOrDate: string | undefined;
	for (const [key, value] of Object.entries(
		headers as Record<string, unknown>,
	)) {
		const raw = Array.isArray(value) ? value[0] : value;
		if (typeof raw !== "string" || raw.trim().length === 0) continue;
		if (key.toLowerCase() === "retry-after-ms") milliseconds = raw.trim();
		if (key.toLowerCase() === "retry-after") secondsOrDate = raw.trim();
	}
	const explicitMilliseconds =
		milliseconds === undefined ? Number.NaN : Number(milliseconds);
	if (Number.isFinite(explicitMilliseconds) && explicitMilliseconds >= 0)
		return explicitMilliseconds;
	if (secondsOrDate === undefined) return undefined;
	const seconds = Number(secondsOrDate);
	if (Number.isFinite(seconds))
		return seconds >= 0 && Number.isFinite(seconds * 1000)
			? seconds * 1000
			: undefined;
	const at = Date.parse(secondsOrDate);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Structural provider HTTP status from one error node, if any. */
function nodeStatus(node: object): number | undefined {
	const raw = (node as { statusCode?: unknown; status?: unknown }).statusCode;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const status = (node as { status?: unknown }).status;
	if (typeof status === "number" && Number.isFinite(status)) return status;
	return undefined;
}

/**
 * Explicit credit exhaustion is not a temporary rate-limit window. Any node in
 * the wrapped provider-error graph may carry the provider's quota codes.
 */
export function isPermanentQuotaError(error: unknown): boolean {
	const codes = new Set(["insufficient_quota", "credit_balance_exhausted"]);
	const inspect = (value: unknown): boolean => {
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		return (
			(typeof record.code === "string" && codes.has(record.code)) ||
			(typeof record.type === "string" && codes.has(record.type)) ||
			(typeof record.error === "object" &&
				record.error !== null &&
				["code", "type"].some((key) => {
					const field = (record.error as Record<string, unknown>)[key];
					return typeof field === "string" && codes.has(field);
				}))
		);
	};
	for (const node of retryEvidenceNodes(error)) {
		const record = node as Record<string, unknown>;
		if (inspect(record) || inspect(record.data)) return true;
		if (typeof record.responseBody !== "string") continue;
		try {
			if (inspect(JSON.parse(record.responseBody))) return true;
		} catch {
			// error-policy:J3 malformed provider bodies cannot establish permanent quota exhaustion.
		}
	}
	return false;
}

/**
 * Absolute deadline survives evaluator processing before task persistence.
 * The 429 and its retry hint may sit on any node of the wrapped provider-error
 * graph; permanent quota exhaustion anywhere in the graph rejects the wait.
 */
export function providerRateLimitRetryAt(
	error: unknown,
	now = Date.now(),
): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (isPermanentQuotaError(error)) return undefined;
	for (const node of retryEvidenceNodes(error)) {
		if (nodeStatus(node) !== 429) continue;
		const explicit = (node as { retryAfterMs?: unknown }).retryAfterMs;
		const delay =
			typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0
				? explicit
				: providerRetryAfterMs(node, now);
		const deadline = delay === undefined ? Number.NaN : now + delay;
		if (Number.isFinite(deadline) && deadline > now) return deadline;
	}
	return undefined;
}

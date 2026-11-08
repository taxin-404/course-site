/**
 * Client retry policy for JSON API calls. A GET that got no usable answer is worth one
 * more attempt; a write is never retried, because the first request may have succeeded
 * and repeating it could duplicate the change.
 */
export const DEFAULT_RETRY_MS = 2000;
export const MAX_RETRY_MS = 5000;

/** `Retry-After` in delta-seconds or HTTP-date form, clamped to something a person waits for. */
export function retryDelayMs(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_MS;
  return Math.min(Math.max(ms, 0), MAX_RETRY_MS);
}

export type Wait = (ms: number) => Promise<void>;

const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run`, and for a GET only retries it exactly once when the answer was a 503 or the
 * call threw (network failure or the caller's timeout). The second outcome is final.
 */
export async function fetchWithRetry(
  method: string,
  run: () => Promise<Response>,
  wait: Wait = sleep,
): Promise<Response> {
  let first: Response;
  try {
    first = await run();
  } catch (e) {
    if (method !== 'GET') throw e;
    await wait(DEFAULT_RETRY_MS);
    return run();
  }
  if (method !== 'GET' || first.status !== 503) return first;
  // The 503 body is not needed; release it before waiting to retry.
  await first.body?.cancel().catch(() => {});
  await wait(retryDelayMs(first.headers.get('retry-after')));
  return run();
}
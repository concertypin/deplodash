/**
 * Best-effort rate limiting over the Cloudflare `ratelimit` binding.
 *
 * The binding is optional (absent in local dev and most tests) and a failing
 * limiter must never block requests, so both cases count as "not limited".
 */
export async function isRateLimited(
    limiter: RateLimit | undefined,
    key: string
): Promise<boolean> {
    if (!limiter) return false;
    try {
        const { success } = await limiter.limit({ key });
        return !success;
    } catch {
        // Rate limiter unavailable (e.g., local dev) — proceed
        return false;
    }
}

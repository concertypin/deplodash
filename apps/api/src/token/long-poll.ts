/**
 * Long-poll until a consent check passes, the client disconnects, or the
 * wait times out. Shared by the repository and OIDC `/wait` endpoints.
 *
 * Wakes up on an in-isolate notification (`subscribe`) and, because the
 * approving request may land on another isolate, also re-checks KV every
 * `pollIntervalMs`.
 */

export type LongPollOutcome = "approved" | "timeout" | "aborted";

export const WAIT_TIMEOUT_MS = 90 * 1000;
export const WAIT_POLL_INTERVAL_MS = 5000;

export function waitForApproval(options: {
    check: () => Promise<boolean>;
    subscribe: (onNotify: () => void) => () => void;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<LongPollOutcome> {
    const {
        check,
        subscribe,
        signal,
        timeoutMs = WAIT_TIMEOUT_MS,
        pollIntervalMs = WAIT_POLL_INTERVAL_MS,
    } = options;

    return new Promise<LongPollOutcome>((resolve) => {
        let finished = false;

        const finish = (outcome: LongPollOutcome) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutId);
            clearInterval(pollIntervalId);
            unsubscribe();
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
        };

        const recheck = (label: string) => {
            void (async () => {
                try {
                    if (await check()) finish("approved");
                } catch (e) {
                    console.error(label, e);
                }
            })();
        };

        // 1. In-isolate notification for instant wake-up; double-check KV.
        const unsubscribe = subscribe(() =>
            recheck("Error in wait-notifier listener")
        );
        const timeoutId = setTimeout(() => finish("timeout"), timeoutMs);
        const pollIntervalId = setInterval(
            () => recheck("Error polling for consent"),
            pollIntervalMs
        );

        // Cloudflare Workers specific: resolve if the client disconnects.
        // An already-aborted signal never fires "abort" again.
        const onAbort = () => finish("aborted");
        if (signal?.aborted) {
            finish("aborted");
            return;
        }
        signal?.addEventListener("abort", onAbort);
    });
}

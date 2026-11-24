import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForApproval } from "@/token/long-poll";

/** A subscribe() stub that exposes the registered callback and its unsubscribe. */
function subscription() {
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn<() => void>();
    return {
        subscribe: (onNotify: () => void) => {
            notify = onNotify;
            return unsubscribe;
        },
        notify: () => notify?.(),
        unsubscribe,
    };
}

describe("waitForApproval", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("wakes up on the notification without waiting for a poll", async () => {
        let approved = false;
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(approved),
            subscribe: sub.subscribe,
            pollIntervalMs: 1e9,
        });
        approved = true;
        sub.notify();
        await vi.advanceTimersByTimeAsync(0);
        await expect(outcome).resolves.toBe("approved");
        expect(sub.unsubscribe).toHaveBeenCalledOnce();
    });

    it("ignores a notification whose re-check still fails", async () => {
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(false),
            subscribe: sub.subscribe,
            timeoutMs: 1000,
            pollIntervalMs: 1e9,
        });
        sub.notify();
        await vi.advanceTimersByTimeAsync(1000);
        await expect(outcome).resolves.toBe("timeout");
    });

    it("falls back to polling for approvals from another isolate", async () => {
        let approved = false;
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(approved),
            subscribe: sub.subscribe,
            pollIntervalMs: 5000,
        });
        approved = true;
        await vi.advanceTimersByTimeAsync(5000);
        await expect(outcome).resolves.toBe("approved");
    });

    it("times out and cleans up", async () => {
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(false),
            subscribe: sub.subscribe,
        });
        await vi.advanceTimersByTimeAsync(90_000);
        await expect(outcome).resolves.toBe("timeout");
        expect(sub.unsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves on client abort", async () => {
        const controller = new AbortController();
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(false),
            subscribe: sub.subscribe,
            signal: controller.signal,
        });
        controller.abort();
        await expect(outcome).resolves.toBe("aborted");
        expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves at once for a signal that is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const sub = subscription();
        const outcome = waitForApproval({
            check: () => Promise.resolve(false),
            subscribe: sub.subscribe,
            signal: controller.signal,
        });
        await expect(outcome).resolves.toBe("aborted");
        expect(sub.unsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps waiting when a check throws", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        let calls = 0;
        const outcome = waitForApproval({
            check: () => {
                calls++;
                return calls === 1
                    ? Promise.reject(new Error("KV unavailable"))
                    : Promise.resolve(true);
            },
            subscribe: subscription().subscribe,
            pollIntervalMs: 5000,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(outcome).resolves.toBe("approved");
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});

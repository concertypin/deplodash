import { describe, expect, it, vi } from "vitest";
import { isRateLimited } from "@/rate-limit";

describe("isRateLimited", () => {
    it.concurrent("is false without a limiter binding", async () => {
        expect(await isRateLimited(undefined, "k")).toBe(false);
    });

    it.concurrent("passes the key and reports a denied request", async () => {
        const limit = vi.fn<RateLimit["limit"]>(() =>
            Promise.resolve({ success: false })
        );
        expect(await isRateLimited({ limit }, "agent:1")).toBe(true);
        expect(limit).toHaveBeenCalledWith({ key: "agent:1" });
    });

    it.concurrent("is false for an allowed request", async () => {
        expect(
            await isRateLimited(
                { limit: () => Promise.resolve({ success: true }) },
                "k"
            )
        ).toBe(false);
    });

    it.concurrent("fails open when the limiter throws", async () => {
        expect(
            await isRateLimited(
                { limit: () => Promise.reject(new Error("unavailable")) },
                "k"
            )
        ).toBe(false);
    });
});

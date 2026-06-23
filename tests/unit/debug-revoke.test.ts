import { describe, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { TokenService } from "@/token-service";

describe("debug revoke", () => {
    beforeEach(async () => {
        const { keys } = await env.KV.list();
        await Promise.all(keys.map((k) => env.KV.delete(k.name)));
    });

    // eslint-disable-next-line vitest/expect-expect
    it("debug", async () => {
        const ts = new TokenService(env.KV);
        await ts.recordConsent("test-agent", "owner/repo", ["contents:read"]);

        try {
            await ts.revokeConsent("", "owner/repo", ["contents:read"]);
            console.log("revoke succeeded");
        } catch (e) {
            const err = e as Error;
            console.log("revoke error:", err.message);
        }

        const check = await ts.checkConsent("test-agent", "owner/repo", [
            "contents:read",
        ]);
        console.log("check:", check);
    });
});

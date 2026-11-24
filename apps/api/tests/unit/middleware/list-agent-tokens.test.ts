import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { listAgentTokens, registerAgentToken } from "@/middleware/agent-auth";
import { clearKV } from "@tests/helpers";

describe("listAgentTokens", () => {
    beforeEach(async () => {
        await clearKV(env.KV);
    });

    it("follows the cursor past the first page", async () => {
        for (const id of ["a", "b", "c"]) {
            await registerAgentToken(env.KV, `tok-${id}`, id);
        }
        // One key per page forces two cursor hops.
        const tokens = await listAgentTokens(env.KV, 1);
        expect(tokens.map((t) => t.info.agent_id).sort()).toEqual([
            "a",
            "b",
            "c",
        ]);
    });
});

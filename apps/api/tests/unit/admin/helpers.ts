import { Hono } from "hono";
import type { HonoEnv, SessionPayload } from "@/types";
import { adminRouter } from "@/routes/admin";
import { sessionMiddleware } from "@/middleware";
import { resetKeyCache, getOrInitKey, encryptWith } from "@/crypto";
import { vi } from "vitest";
import { TEST_SECRET } from "../../helpers";

export function createAdminApp(): { app: Hono<HonoEnv> } {
    const app = new Hono<HonoEnv>()
        .use("*", sessionMiddleware())
        .route("/api/admin", adminRouter);
    return { app };
}

export async function encryptSessionCookie(ghToken: string): Promise<string> {
    const key = await getOrInitKey(TEST_SECRET);
    const payload: SessionPayload = {
        accessToken: ghToken,
        refreshToken: "dummy-refresh-token",
        accessExpiresAt: Date.now() + 3600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
    };
    return `session=${await encryptWith(key, JSON.stringify(payload))}`;
}

export function mockGitHubUser(login: string): void {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                login,
                id: 1,
                avatar_url: "",
                name: "Test User",
            })
        )
    );
}

export function adminEnv(
    adminUsers: string,
    base: HonoEnv["Bindings"]
): HonoEnv["Bindings"] {
    return { ...base, GITHUB_ADMIN_USERS: adminUsers };
}

export { resetKeyCache }; // re-export for test files to use in beforeEach

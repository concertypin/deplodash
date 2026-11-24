import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import OidcConsentPage from "@/lib/OidcConsentPage.svelte";

const AUDIENCE =
    "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/agents-pool/providers/deplodash";
const UID = "abcdefghijklmnopqrstuv";

function jsonResponse(data: unknown, status = 200) {
    return Promise.resolve(
        new Response(JSON.stringify(data), {
            status,
            headers: { "Content-Type": "application/json" },
        })
    );
}

function requestUrl(input: string | URL | Request): string {
    return typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.href;
}

function openConsentUrl(params: Record<string, string>) {
    window.history.replaceState(
        null,
        "",
        `/auth/oidc-consent?${new URLSearchParams(params).toString()}`
    );
}

type Agent = { agent_id: string; label: string; oidc_subject: string };

/** Stub the API: the signed-in user owns `agents`; `onConsent` answers POST /api/consent/oidc. */
function stubApi(
    agents: Agent[],
    onConsent?: (body: unknown) => Promise<Response>
) {
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>((input, init) => {
            const url = requestUrl(input);
            if (url === "/api/user/me") {
                return jsonResponse({ login: "owner", avatarUrl: "" });
            }
            if (url === "/api/user/agent/list") {
                return jsonResponse({
                    status: "ok",
                    tokens: agents.map((agent) => ({
                        token: `tok-${agent.agent_id}`,
                        created_at: "2026-11-24T00:00:00Z",
                        ...agent,
                    })),
                });
            }
            if (url === "/api/consent/oidc" && onConsent) {
                return onConsent(
                    JSON.parse(
                        typeof init?.body === "string" ? init.body : "null"
                    )
                );
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        })
    );
}

const OWN_AGENT: Agent = {
    agent_id: "gcp-agent",
    label: "GCP agent",
    oidc_subject: `agent:${UID}`,
};

describe("OidcConsentPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shows the agent, the parsed provider and the subject", async () => {
        openConsentUrl({
            agent_id: "gcp-agent",
            agent_uid: UID,
            audience: AUDIENCE,
        });
        stubApi([OWN_AGENT]);

        const screen = await render(OidcConsentPage);

        await expect
            .element(screen.getByText("Google Cloud Access Required"))
            .toBeVisible();
        await expect.element(screen.getByText("gcp-agent")).toBeVisible();
        await expect.element(screen.getByText("123456789012")).toBeVisible();
        await expect.element(screen.getByText("agents-pool")).toBeVisible();
        await expect
            .element(screen.getByText("deplodash", { exact: true }))
            .toBeVisible();
        await expect.element(screen.getByText(`agent:${UID}`)).toBeVisible();
    });

    it("names the agent from the server by uid, ignoring a spoofed agent_id in the link", async () => {
        // A crafted link claims "prod-deploy" but carries the uid of the
        // owner's "gcp-agent". agent_ids can also repeat across users, so the
        // name in the link means nothing.
        openConsentUrl({
            agent_id: "prod-deploy",
            agent_uid: UID,
            audience: AUDIENCE,
        });
        stubApi([
            OWN_AGENT,
            {
                agent_id: "prod-deploy",
                label: "Prod",
                oidc_subject: "agent:zzzzzzzzzzzzzzzzzzzzzz",
            },
        ]);

        const screen = await render(OidcConsentPage);

        await expect.element(screen.getByText("gcp-agent")).toBeVisible();
        expect(screen.container.textContent).not.toContain("prod-deploy");
    });

    it("refuses a uid that is not one of the user's agents", async () => {
        openConsentUrl({
            agent_id: "gcp-agent",
            agent_uid: UID,
            audience: AUDIENCE,
        });
        // The user has agents, just none with this uid: a fallback to the
        // first agent must not slip through.
        stubApi([
            { ...OWN_AGENT, oidc_subject: "agent:zzzzzzzzzzzzzzzzzzzzzz" },
        ]);

        const screen = await render(OidcConsentPage);

        await expect
            .element(screen.getByText(/does not belong to your account/))
            .toBeVisible();
        expect(screen.container.querySelector("button")).toBeNull();
    });

    it("rejects an audience that is not a GCP provider", async () => {
        openConsentUrl({
            agent_id: "gcp-agent",
            agent_uid: UID,
            audience: "https://evil.example/aud",
        });
        stubApi([OWN_AGENT]);

        const screen = await render(OidcConsentPage);

        await expect
            .element(screen.getByText(/Invalid consent request/))
            .toBeVisible();
    });

    it("renders server-provided names as text, not HTML", async () => {
        openConsentUrl({ agent_uid: UID, audience: AUDIENCE });
        stubApi([
            { ...OWN_AGENT, agent_id: '<img src="x" data-injected="1">' },
        ]);

        const screen = await render(OidcConsentPage);

        await expect
            .element(screen.getByText('<img src="x" data-injected="1">'))
            .toBeVisible();
        expect(screen.container.querySelector("[data-injected]")).toBeNull();
    });

    it("posts the uid and audience on Allow and shows server errors", async () => {
        openConsentUrl({
            agent_id: "gcp-agent",
            agent_uid: UID,
            audience: AUDIENCE,
        });
        const consentBodies: unknown[] = [];
        stubApi([OWN_AGENT], (body) => {
            consentBodies.push(body);
            return jsonResponse(
                { error: "Only the agent's owner can change its OIDC access" },
                403
            );
        });

        const screen = await render(OidcConsentPage);
        await screen.getByRole("button", { name: "Allow" }).click();

        await expect
            .element(screen.getByRole("alert"))
            .toHaveTextContent(
                "Only the agent's owner can change its OIDC access"
            );
        expect(consentBodies).toEqual([{ agent_uid: UID, audience: AUDIENCE }]);
    });
});

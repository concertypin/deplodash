import { describe, expect, it } from "vitest";
import {
    describeGcpAudience,
    findAgentBySubject,
    parseOidcConsentParams,
} from "@/lib/oidc";

const AUDIENCE =
    "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/agents-pool/providers/deplodash";

describe("describeGcpAudience", () => {
    it("splits a canonical GCP audience into its parts", () => {
        expect(describeGcpAudience(AUDIENCE)).toEqual({
            projectNumber: "123456789012",
            poolId: "agents-pool",
            providerId: "deplodash",
        });
    });

    it.each([
        [
            "another host",
            AUDIENCE.replace("iam.googleapis.com", "evil.example"),
        ],
        ["a trailing path", `${AUDIENCE}/x`],
        ["the non-canonical // form", AUDIENCE.replace(/^https:/, "")],
        ["garbage", "not-an-audience"],
    ])("returns null for %s", (_label, audience) => {
        expect(describeGcpAudience(audience)).toBeNull();
    });
});

describe("parseOidcConsentParams", () => {
    const UID = "abcdefghijklmnopqrstuv";

    it("reads the uid and audience and ignores agent_id", () => {
        const search = `?${new URLSearchParams({
            agent_id: "spoofed",
            agent_uid: UID,
            audience: AUDIENCE,
        }).toString()}`;
        const parsed = parseOidcConsentParams(search);
        expect(parsed).toEqual({
            agentUid: UID,
            audience: AUDIENCE,
            gcp: {
                projectNumber: "123456789012",
                poolId: "agents-pool",
                providerId: "deplodash",
            },
        });
    });

    it.each([
        ["no uid", { audience: AUDIENCE }],
        ["no audience", { agent_uid: UID }],
        [
            "a non-GCP audience",
            { agent_uid: UID, audience: "https://x.example" },
        ],
    ])("returns null with %s", (_label, params: Record<string, string>) => {
        expect(
            parseOidcConsentParams(`?${new URLSearchParams(params).toString()}`)
        ).toBeNull();
    });
});

describe("findAgentBySubject", () => {
    // Two users can both have an agent called "asdf"; only the uid tells
    // them apart.
    const agents = [
        { agent_id: "asdf", oidc_subject: "agent:uid-of-user-1-agent-x" },
        { agent_id: "asdf", oidc_subject: "agent:uid-of-user-2-agent-y" },
        { agent_id: "legacy" },
    ];

    it("matches the exact subject, not the agent_id", () => {
        expect(findAgentBySubject(agents, "uid-of-user-2-agent-y")).toBe(
            agents[1]
        );
    });

    it("returns null when no agent has that uid", () => {
        expect(findAgentBySubject(agents, "uid-of-user-2")).toBeNull();
        expect(findAgentBySubject(agents, "")).toBeNull();
    });
});

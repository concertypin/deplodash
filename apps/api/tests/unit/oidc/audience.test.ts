import { describe, expect, it } from "vitest";
import { parseAudience } from "@/oidc/audience";

const CANONICAL =
    "https://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/agents-pool/providers/deplodash";

describe("parseAudience (GCP)", () => {
    it.concurrent("accepts the default allowed audience and splits it", () => {
        expect(parseAudience(CANONICAL)).toEqual({
            provider: "gcp",
            audience: CANONICAL,
            projectNumber: "123456789012",
            poolId: "agents-pool",
            providerId: "deplodash",
        });
    });

    it.concurrent(
        "canonicalizes the //iam.googleapis.com resource name to the https form",
        () => {
            expect(
                parseAudience(CANONICAL.replace(/^https:/, ""))?.audience
            ).toBe(CANONICAL);
        }
    );

    it.concurrent.each([
        [
            "another host",
            CANONICAL.replace("iam.googleapis.com", "evil.example"),
        ],
        [
            "a lookalike host",
            CANONICAL.replace(
                "iam.googleapis.com",
                "iam.googleapis.com.evil.example"
            ),
        ],
        ["http scheme", CANONICAL.replace("https:", "http:")],
        [
            "project ID instead of number",
            CANONICAL.replace("123456789012", "my-project"),
        ],
        [
            "project number with a leading zero",
            CANONICAL.replace("123456789012", "0123"),
        ],
        [
            "a non-global location",
            CANONICAL.replace("/global/", "/us-central1/"),
        ],
        ["a too-short pool id", CANONICAL.replace("agents-pool", "abc")],
        [
            "a too-long provider id",
            CANONICAL.replace("deplodash", "a".repeat(33)),
        ],
        ["uppercase ids", CANONICAL.replace("agents-pool", "Agents-Pool")],
        ["a trailing slash", `${CANONICAL}/`],
        ["a query string", `${CANONICAL}?x=1`],
        ["a fragment", `${CANONICAL}#x`],
        ["leading whitespace", ` ${CANONICAL}`],
        ["a trailing newline", `${CANONICAL}\n`],
        ["an extra path segment", `${CANONICAL}/extra`],
        [
            "the bare provider path",
            "projects/1/locations/global/workloadIdentityPools/pool1/providers/prov1",
        ],
        ["an Entra audience (not yet supported)", "api://AzureADTokenExchange"],
        ["an empty string", ""],
    ])("rejects %s", (_label, audience) => {
        expect(parseAudience(audience)).toBeNull();
    });
});

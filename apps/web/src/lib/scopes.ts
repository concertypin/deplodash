/**
 * Scope categories for the consent page UI.
 * Mirrors SCOPE_CATEGORIES from the API (deplodash/packages/api/src/github/scopes.ts).
 */
export const scopeCategories: {
    label: string;
    scopes: Array<{ id: string; description: string }>;
}[] = [
    {
        label: "Repository Contents",
        scopes: [
            { id: "contents:read", description: "Read repository contents" },
            {
                id: "contents:write",
                description: "Read & write repository contents",
            },
            { id: "workflows:write", description: "Manage workflow files" },
        ],
    },
    {
        label: "Issues",
        scopes: [
            { id: "issues:read", description: "Read issues" },
            { id: "issues:write", description: "Read & write issues" },
        ],
    },
    {
        label: "Pull Requests",
        scopes: [
            { id: "pulls:read", description: "Read pull requests" },
            { id: "pulls:write", description: "Read & write pull requests" },
        ],
    },
    {
        label: "Actions & CI",
        scopes: [
            {
                id: "actions:read",
                description: "View Actions workflows & runs",
            },
            {
                id: "actions:write",
                description: "Manage Actions workflows & runs",
            },
            { id: "checks:read", description: "View check runs & suites" },
            { id: "checks:write", description: "Create & update check runs" },
            { id: "variables:read", description: "View Actions variables" },
            { id: "variables:write", description: "Manage Actions variables" },
        ],
    },
    {
        label: "Metadata",
        scopes: [
            { id: "metadata:read", description: "Read repository metadata" },
            { id: "deployments:read", description: "View deployments" },
            { id: "deployments:write", description: "Manage deployments" },
        ],
    },
    {
        label: "Administration",
        scopes: [
            {
                id: "administration:read",
                description: "View repository settings",
            },
            {
                id: "administration:write",
                description: "Manage repository settings",
            },
            {
                id: "admin",
                description:
                    "Full admin access (contents, workflows, and repository administration)",
            },
        ],
    },
    {
        label: "Security & Access",
        scopes: [
            {
                id: "secrets:read",
                description: "View repository secrets & variables",
            },
            {
                id: "secrets:write",
                description: "Manage repository secrets & variables",
            },
            { id: "members:read", description: "View collaborators" },
            { id: "members:write", description: "Manage collaborators" },
        ],
    },
    {
        label: "Pages & Webhooks",
        scopes: [
            { id: "pages:read", description: "View GitHub Pages settings" },
            {
                id: "pages:write",
                description: "Manage GitHub Pages settings & builds",
            },
            { id: "webhooks:read", description: "View webhooks" },
            { id: "webhooks:write", description: "Manage webhooks" },
        ],
    },
    {
        label: "Environments",
        scopes: [
            { id: "environments:read", description: "View environments" },
            { id: "environments:write", description: "Manage environments" },
        ],
    },
];

export const approvableScopeIds = new Set(
    scopeCategories.flatMap((category) =>
        category.scopes.map((scope) => scope.id)
    )
);

/**
 * Compound/builtin presets accepted by the consent endpoint.
 * Mirrors LEGACY_PRESETS from the API (apps/api/src/github/scopes.ts).
 * The consent page expands these into selectable granular scopes.
 */
const COMPOUND_SCOPE_PRESETS: Record<string, string[]> = {
    admin: [
        "metadata:read",
        "contents:write",
        "workflows:write",
        "administration:write",
    ],
    "contents:write+workflows:write": [
        "metadata:read",
        "contents:write",
        "workflows:write",
    ],
};

/**
 * Expand compound presets into their constituent granular scopes.
 * Non-preset scopes pass through unchanged.
 */
export function expandCompoundScopes(scopes: string[]): string[] {
    const expanded = new Set<string>();
    for (const scope of scopes) {
        const preset = COMPOUND_SCOPE_PRESETS[scope];
        if (preset) {
            for (const granular of preset) expanded.add(granular);
        } else {
            expanded.add(scope);
        }
    }
    return [...expanded];
}

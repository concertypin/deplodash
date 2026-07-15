// ─── Custom Errors ───────────────────────────────────────────────────────────

export class TokenExpiredError extends Error {
    constructor(msg?: string) {
        super(msg ?? "GitHub token expired or invalid");
        this.name = "TokenExpiredError";
    }
}

/**
 * Thrown when a caller attempts to revoke a consent they do not own.
 */
export class ConsentOwnershipError extends Error {
    constructor(msg?: string) {
        super(msg ?? "You can only revoke your own consents.");
        this.name = "ConsentOwnershipError";
    }
}

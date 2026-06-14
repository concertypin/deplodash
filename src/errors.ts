// ─── Custom Errors ───────────────────────────────────────────────────────────

export class TokenExpiredError extends Error {
    constructor(msg?: string) {
        super(msg ?? "GitHub token expired or invalid");
        this.name = "TokenExpiredError";
    }
}

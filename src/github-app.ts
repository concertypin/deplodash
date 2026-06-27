/**
 * Re-export from the new github module location.
 * This file exists for backward compatibility — all implementations
 * live in src/github/.
 */
export { GitHubApp } from "@/github/app";
export { permissionsFromScopes } from "@/github/scopes";
export { pemToCryptoKey } from "@/github/pem-utils";
export type { InstallationToken } from "@/github/app";

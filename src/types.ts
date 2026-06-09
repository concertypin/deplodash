// ─── Types ───────────────────────────────────────────────────────────────────

export type Repo = {
  readonly full_name: string;
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly private: boolean;
  readonly permissions?: { readonly admin: boolean; readonly push: boolean; readonly pull: boolean };
  readonly html_url: string;
  readonly description: string | null;
};

export type DeployKey = { readonly id: number; readonly key: string; readonly title: string; readonly read_only: boolean; readonly verified: boolean };

export type RepoStatus = { repo: Repo; keyId: number | null; hasAdmin: boolean };

export type AppState = {
  sshKey: string;
  sshKeyTitle: string;
  normalizedKey: string;
  repos: RepoStatus[];
  loadedAt: Date;
  readOnly: boolean;
};

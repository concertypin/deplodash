import { escapeHtml } from "@/helpers";

// ─── HTML Templates ──────────────────────────────────────────────────────────

export function renderLoginPage(redirectUrl: string): string {
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'">
<title>Deplodash — Login</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content text-center">
    <div class="max-w-md">
      <div class="mb-6"><i data-lucide="bot" class="w-16 h-16 mx-auto text-primary"></i></div>
      <h1 class="text-3xl font-bold mb-2">Deplodash</h1>
      <p class="text-base-content/60 mb-8">GitHub App Token Service — Issue scoped installation tokens for AI agents.</p>
      <a href="${escapeHtml(redirectUrl)}" class="btn btn-primary btn-lg gap-2">
        <i data-lucide="github" class="w-5 h-5"></i>Login with GitHub
      </a>
    </div>
  </div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons()</script>
</body>
</html>`;
}

export function renderHomePage(params: {
    login: string;
    avatarUrl: string;
}): string {
    const { login, avatarUrl } = params;
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'">
<title>Deplodash — Token Service</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="drawer lg:drawer-open">
<input id="drawer" type="checkbox" class="drawer-toggle" />
<div class="drawer-content flex flex-col">
  <nav class="navbar bg-base-200 shadow-sm">
    <div class="flex-none lg:hidden"><label for="drawer" class="btn btn-square btn-ghost"><i data-lucide="menu" class="w-5 h-5"></i></label></div>
    <div class="flex-1"><span class="text-lg font-bold">🤖 Deplodash</span></div>
    <div class="flex-none gap-2">
      <span class="text-sm text-base-content/60 hidden sm:inline">${escapeHtml(login)}</span>
      <div class="avatar">
        <div class="w-8 rounded-full">
          <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(login)}" />
        </div>
      </div>
      <a href="/logout" class="btn btn-ghost btn-sm gap-1"><i data-lucide="log-out" class="w-4 h-4"></i>Logout</a>
    </div>
  </nav>
  <div class="p-8 max-w-2xl mx-auto space-y-6">
    <div class="hero">
      <div class="hero-content text-center p-0">
        <div class="max-w-lg">
          <div class="mb-4"><i data-lucide="bot" class="w-16 h-16 mx-auto text-primary"></i></div>
          <h1 class="text-3xl font-bold">Deplodash</h1>
          <p class="text-base-content/60 mt-2">
            GitHub App Token Service — issue scoped installation tokens for AI agents.
          </p>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <div class="space-y-3">
      <h2 class="text-xl font-semibold">Quick Start</h2>
      <div class="bg-base-200 rounded-box p-4">
        <p class="text-sm text-base-content/70 mb-3">
          Agents request tokens via the API. You manage consent for repositories.
        </p>
        <div class="text-sm space-y-2 font-mono">
          <div class="bg-base-300 rounded p-3">
            <div class="text-xs text-base-content/50 mb-1">Request a token</div>
            <pre>POST /api/token\nAuthorization: Bearer &lt;agent_token&gt;\n{"repo": "owner/repo", "scopes": ["contents:write"]}</pre>
          </div>
          <div class="bg-base-300 rounded p-3">
            <div class="text-xs text-base-content/50 mb-1">Response</div>
            <pre>{"status": "ok", "token": "ghs_...", "expires_at": "..."}</pre>
          </div>
        </div>
      </div>
    </div>

    <div class="space-y-3">
      <h2 class="text-xl font-semibold">Manage Consent</h2>
      <p class="text-sm text-base-content/60">
        When an agent requests access to a repository, you'll need to approve it
        via the consent page before a token can be issued.
      </p>
    </div>

    <div class="space-y-3">
      <h2 class="text-xl font-semibold">Resources</h2>
      <ul class="menu bg-base-200 rounded-box p-2">
        <li><a href="/llms.txt" class="gap-2"><i data-lucide="file-text" class="w-4 h-4"></i>Agent Guide (/llms.txt)</a></li>
        <li><a href="/docs" class="gap-2"><i data-lucide="book-open" class="w-4 h-4"></i>API Docs (Scalar)</a></li>
        <li><a href="/openapi.json" class="gap-2"><i data-lucide="code" class="w-4 h-4"></i>OpenAPI Spec</a></li>
      </ul>
    </div>
  </div>
</div>
<div class="drawer-side">
<label for="drawer" class="drawer-overlay"></label>
<aside class="bg-base-200 min-h-full w-60 p-4 space-y-4">
  <div class="text-lg font-bold mt-2">🤖 Deplodash</div>
  <ul class="menu p-0">
    <li><a href="/" class="gap-2"><i data-lucide="home" class="w-4 h-4"></i>Home</a></li>
    <li><a href="/llms.txt" class="gap-2"><i data-lucide="file-text" class="w-4 h-4"></i>Agent Guide</a></li>
    <li><a href="/docs" class="gap-2"><i data-lucide="book-open" class="w-4 h-4"></i>API Docs</a></li>
    <li><a href="/logout" class="gap-2"><i data-lucide="log-out" class="w-4 h-4"></i>Logout</a></li>
  </ul>
</aside>
</div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>lucide.createIcons()</script>
</body>
</html>`;
}

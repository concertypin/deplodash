import { escapeHtml } from "@/helpers";
import type { RepoStatus, AppState } from "@/types";

// ─── HTML Templates ──────────────────────────────────────────────────────────

export function renderLoginPage(redirectUrl: string): string {
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'">
<title>Deploy Key Dashboard — Login</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content text-center">
    <div class="max-w-md">
      <div class="mb-6"><i data-lucide="key-round" class="w-16 h-16 mx-auto text-primary"></i></div>
      <h1 class="text-3xl font-bold mb-2">Deploy Key Dashboard</h1>
      <p class="text-base-content/60 mb-8">Manage GitHub deploy keys across all your repositories.</p>
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

export function renderSetupPage(): string {
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'">
<title>Set Up SSH Key</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content w-full max-w-lg">
    <div class="card bg-base-200 shadow-xl w-full">
      <div class="card-body">
        <h2 class="card-title mb-2">🔑 Enter SSH Public Key</h2>
        <p class="text-sm text-base-content/60 mb-4">Paste the SSH public key that should be registered as a deploy key.</p>
        <textarea id="pubkey" class="textarea textarea-bordered font-mono text-sm w-full h-28" placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."></textarea>
        <div id="err" class="text-error text-sm hidden"></div>
        <div class="card-actions justify-end mt-4">
          <button class="btn btn-primary w-full" onclick="submitKey()">Save SSH Key</button>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
async function submitKey(){
  const k=document.getElementById("pubkey").value.trim();
  const e=document.getElementById("err");
  if(!k.startsWith("ssh-")){e.textContent="Invalid SSH public key (must start with ssh-...)";e.classList.remove("hidden");return}
  e.classList.add("hidden");
  const r=await fetch("/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pubkey:k})});
  if(r.ok)location.href="/";else{const d=await r.json();e.textContent=d.error||"Error";e.classList.remove("hidden")}
}
document.getElementById("pubkey").addEventListener("keydown",e=>{if(e.key==="Enter"&&e.ctrlKey)submitKey()});
</script>
</body>
</html>`;
}

export function renderRegisterPage(params: {
    repo: string;
    pubkey: string;
    perm: string;
    keyName: string;
    success?: string;
    error?: string;
}): string {
    const { repo, pubkey, perm, keyName, success, error } = params;
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'">
<title>Register Deploy Key — ${escapeHtml(repo || "(no repo)")}</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="hero min-h-screen">
  <div class="hero-content w-full max-w-lg">
    <div class="card bg-base-200 shadow-xl w-full">
      <div class="card-body">
        <h2 class="card-title mb-2">🔑 Register Deploy Key</h2>
        ${
            success
                ? `<div class="alert alert-success mb-4">${escapeHtml(success)}</div>`
                : error
                  ? `<div class="alert alert-error mb-4">${escapeHtml(error)}</div>`
                  : ""
        }
        <form action="/api/register" method="POST" class="space-y-4">
          <div>
            <label class="label"><span class="label-text">Repository</span></label>
            <input name="repo" value="${escapeHtml(repo)}" class="input input-bordered w-full font-mono text-sm" ${repo.match(/^[\w.-]+\/[\w.-]+$/) ? "readonly" : ""} placeholder="owner/repo" required>
          </div>
          <div>
            <label class="label"><span class="label-text">SSH Public Key</span></label>
            <textarea id="register-pubkey" name="pubkey" class="textarea textarea-bordered font-mono text-sm w-full h-28" placeholder="ssh-ed25519 ..." required>${escapeHtml(pubkey)}</textarea>
            <label class="label"><span class="label-text-alt" id="pubkey-status">${pubkey ? "✓ Key loaded" : "Paste your SSH public key"}</span></label>
          </div>
          <div>
            <label class="label"><span class="label-text">Permission</span></label>
            <select name="perm" class="select select-bordered w-full">
              <option value="RW" ${perm === "RW" ? "selected" : ""}>Read / Write</option>
              <option value="RO" ${perm === "RO" ? "selected" : ""}>Read Only</option>
            </select>
          </div>
          <div>
            <label class="label"><span class="label-text">Key Name (optional)</span></label>
            <input name="key_name" value="${escapeHtml(keyName)}" class="input input-bordered w-full" placeholder="nanobot">
          </div>
          <div class="card-actions justify-end">
            <button id="register-submit" type="submit" class="btn btn-primary">Register Key</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</div>
<script>
(function(){var b=document.getElementById("register-submit"),k=document.getElementById("register-pubkey");function u(){b.disabled=!k.value.trim()}k.addEventListener("input",u);u()})()
</script>
</body>
</html>`;
}

function renderRow(s: RepoStatus, readOnly: boolean): string {
    const statusKey =
        s.keyId !== null ? "keyed" : s.hasAdmin ? "unkeyed" : "noadmin";
    const label =
        s.keyId !== null
            ? "✅ Keyed"
            : s.hasAdmin
              ? "🔑 Add Key"
              : "⛔ No Admin";
    const badge =
        s.keyId !== null
            ? "badge-success"
            : s.hasAdmin
              ? "badge-warning"
              : "badge-error";
    const actions =
        s.hasAdmin && !readOnly
            ? s.keyId !== null
                ? `<button class="btn btn-ghost btn-xs text-error" onclick="del(${JSON.stringify(s.repo.owner.login)},${JSON.stringify(s.repo.name)},${s.keyId})">Remove</button>`
                : `<button data-repo="${escapeHtml(s.repo.full_name)}" class="btn btn-ghost btn-xs text-primary register-btn">＋ Register</button>`
            : "";
    return `<tr data-name="${escapeHtml(s.repo.full_name.toLowerCase())}" data-status="${statusKey}">
<td class="font-mono text-sm"><a href="${escapeHtml(s.repo.html_url)}" target="_blank" class="link link-hover">${escapeHtml(s.repo.full_name)}</a>${s.repo.private ? ' <span class="badge badge-ghost badge-xs">private</span>' : ""}</td>
<td class="text-sm text-base-content/60">${s.repo.description ? escapeHtml(s.repo.description.slice(0, 60)) : ""}</td>
<td><span class="badge ${badge} badge-sm">${label}</span></td>
<td class="text-right">${actions}</td>
</tr>`;
}

export function renderDashboard(state: AppState): string {
    const { sshKey, repos, loadedAt, readOnly } = state;
    const keyed = repos.filter((r) => r.keyId !== null).length;
    const unkeyed = repos.filter((r) => r.keyId === null && r.hasAdmin).length;
    return `<!DOCTYPE html>
<html lang="en" data-theme="night">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'">
<title>Deploy Key Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div class="drawer lg:drawer-open">
<input id="drawer" type="checkbox" class="drawer-toggle" />
<div class="drawer-content flex flex-col">
  <nav class="navbar bg-base-200 shadow-sm">
    <div class="flex-none lg:hidden"><label for="drawer" class="btn btn-square btn-ghost"><i data-lucide="menu" class="w-5 h-5"></i></label></div>
    <div class="flex-1"><span class="text-lg font-bold">🔑 Deploy Key Dashboard</span></div>
    <div class="flex-none gap-2">
      <span class="text-sm text-base-content/60 hidden sm:inline">${escapeHtml(sshKey)}</span>
      <a href="/logout" class="btn btn-ghost btn-sm gap-1"><i data-lucide="log-out" class="w-4 h-4"></i>Logout</a>
    </div>
  </nav>
  <div class="p-4 space-y-4">
    ${
        repos.length === 0
            ? `<div class="text-center py-16 text-base-content/60">
             <i data-lucide="folder-x" class="w-12 h-12 mx-auto mb-4 text-base-content/30"></i>
             <p class="text-lg font-medium">No repositories found</p>
             <p class="text-sm text-base-content/40">You need admin access to at least one repository.</p>
           </div>`
            : `<div class="flex flex-wrap items-center gap-2">
             <input id="search" class="input input-bordered input-sm w-full sm:w-64" placeholder="Search repos…" oninput="filterRows()">
             <div class="join">
               <button data-filter="all" class="btn btn-xs join-item btn-active" onclick="setFilter(this)">All</button>
               <button data-filter="keyed" class="btn btn-xs join-item" onclick="setFilter(this)">Keyed <span id="cnt-keyed" class="badge badge-xs">${keyed}</span></button>
               <button data-filter="unkeyed" class="btn btn-xs join-item" onclick="setFilter(this)">Unkeyed <span id="cnt-unkeyed" class="badge badge-xs">${unkeyed}</span></button>
             </div>
             <span class="text-xs text-base-content/40">Updated ${escapeHtml(loadedAt.toLocaleString())}</span>
           </div>
           <div id="empty-state" class="hidden text-center py-16 text-base-content/40">No repos match your filter.</div>
           <div class="overflow-x-auto">
             <table class="table table-sm">
               <thead><tr><th>Repository</th><th>Description</th><th>Status</th><th></th></tr></thead>
               <tbody id="tbody">
                 ${repos.map((r) => renderRow(r, readOnly)).join("")}
               </tbody>
             </table>
           </div>`
    }
  </div>
</div>
<div class="drawer-side">
<label for="drawer" class="drawer-overlay"></label>
<aside class="bg-base-200 min-h-full w-60 p-4 space-y-4">
  <div class="text-lg font-bold mt-2">🔑 Deploy Key Dashboard</div>
  <div class="text-xs text-base-content/40 break-all bg-base-300 p-2 rounded">${escapeHtml(sshKey)}</div>
  <ul class="menu p-0">
    <li><a href="/setup" class="gap-2"><i data-lucide="key" class="w-4 h-4"></i>Change SSH Key</a></li>
    <li><a href="/logout" class="gap-2"><i data-lucide="log-out" class="w-4 h-4"></i>Logout</a></li>
  </ul>
</aside>
</div>
</div>
<div id="toast" class="toast toast-top toast-center hidden">
<div id="toast-inner" class="alert shadow-lg">
<div>
  <span id="toast-icon"></span>
  <span id="toast-msg"></span>
</div>
</div>
</div>
<script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js"></script>
<script>
let activeFilter="all",tt;
function setFilter(b){activeFilter=b.dataset.filter;document.querySelectorAll("[data-filter]").forEach(x=>x.classList.remove("btn-active"));b.classList.add("btn-active");filterRows()}
function filterRows(){const q=document.getElementById("search").value.toLowerCase();let v=0;document.querySelectorAll("#tbody tr").forEach(r=>{const s=(!q||r.dataset.name.includes(q))&&(activeFilter==="all"||r.dataset.status===activeFilter);r.style.display=s?"":"none";if(s)v++});document.getElementById("empty-state").classList.toggle("hidden",v>0)}
function toast(m,t){const w=document.getElementById("toast"),i=document.getElementById("toast-inner"),n=document.getElementById("toast-icon"),x=document.getElementById("toast-msg");x.textContent=m;i.className="alert shadow-lg "+(t==="err"?"alert-error":"alert-success");n.setAttribute("data-lucide",t==="err"?"x-circle":"check-circle-2");lucide.createIcons();w.classList.remove("hidden");clearTimeout(tt);tt=setTimeout(()=>w.classList.add("hidden"),3500)}
function adj(k,u){const a=document.getElementById("cnt-keyed"),b=document.getElementById("cnt-unkeyed");a.textContent=Math.max(0,+a.textContent+k);b.textContent=Math.max(0,+b.textContent+u)}
async function del(o,r,i){if(!confirm("Remove deploy key from "+o+"/"+r+"?"))return;const f=await fetch("/api/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:o,repo:r,keyId:i})});if(!f.ok){const d=await f.json();if(d.error==="token_expired"){window.location.href="/auth/github";return}toast(d.error||"Failed","err");return}toast("Key removed","ok");adj(-1,1);document.querySelector('[data-repo="'+o+"/"+r+'"]').closest("tr").dataset.status="unkeyed";filterRows()}
lucide.createIcons();filterRows()
</script>
</body>
</html>`;
}

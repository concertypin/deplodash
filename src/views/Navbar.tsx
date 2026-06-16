/**
 * Top navigation bar for the authenticated dashboard.
 */

import type { FC } from "hono/jsx";

interface NavbarProps {
    login: string;
    avatarUrl: string;
}

export const Navbar: FC<NavbarProps> = ({ login, avatarUrl }) => (
    <nav class="navbar bg-base-200 shadow-sm">
        <div class="flex-none lg:hidden">
            <label for="drawer" class="btn btn-square btn-ghost">
                <i data-lucide="menu" class="w-5 h-5" />
            </label>
        </div>
        <div class="flex-1">
            <span class="text-lg font-bold">🤖 Deplodash</span>
        </div>
        <div class="flex-none gap-2">
            <span class="text-sm text-base-content/60 hidden sm:inline">
                {login}
            </span>
            <div class="avatar">
                <div class="w-8 rounded-full">
                    <img src={avatarUrl} alt={login} />
                </div>
            </div>
            <a href="/logout" class="btn btn-ghost btn-sm gap-1">
                <i data-lucide="log-out" class="w-4 h-4" />
                Logout
            </a>
        </div>
    </nav>
);

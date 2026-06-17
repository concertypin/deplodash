/**
 * Sidebar navigation component for the authenticated dashboard.
 */

import type { FC } from "hono/jsx";

export const Sidebar: FC = () => (
    <aside class="bg-base-200 min-h-full w-60 p-4 space-y-4">
        <div class="text-lg font-bold mt-2">🤖 Deplodash</div>
        <ul class="menu p-0">
            <li>
                <a href="/" class="gap-2">
                    <i data-lucide="home" class="w-4 h-4" />
                    Home
                </a>
            </li>
            <li>
                <a href="/llms.txt" class="gap-2">
                    <i data-lucide="file-text" class="w-4 h-4" />
                    Agent Guide
                </a>
            </li>
            <li>
                <a href="/docs" class="gap-2">
                    <i data-lucide="book-open" class="w-4 h-4" />
                    API Docs
                </a>
            </li>
            <li>
                <a href="/logout" class="gap-2">
                    <i data-lucide="log-out" class="w-4 h-4" />
                    Logout
                </a>
            </li>
        </ul>
    </aside>
);

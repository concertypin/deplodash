/**
 * Base HTML layout component using Hono JSX + DaisyUI + Tailwind + Lucide.
 *
 * Use via `renderPage()` helper which prepends `<!DOCTYPE html>`.
 * Do not embed `<!DOCTYPE html>` directly in JSX — it is not a valid JSX node.
 */

import type { FC, Child } from "hono/jsx";

interface LayoutProps {
    title: string;
    children: Child;
}

export const Layout: FC<LayoutProps> = ({ title, children }) => (
    <html lang="en" data-theme="night">
        <head>
            <meta charset="UTF-8" />
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            />
            <meta
                http-equiv="Content-Security-Policy"
                content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' https://avatars.githubusercontent.com; connect-src 'self'; frame-ancestors 'none'"
            />
            <title>{title}</title>
            <link
                href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css"
                rel="stylesheet"
            />
            <script src="https://cdn.tailwindcss.com" />
            <script src="https://unpkg.com/lucide@0.428.0/dist/umd/lucide.min.js" />
        </head>
        <body>{children}</body>
    </html>
);

/**
 * Render a page component with `<!DOCTYPE html>` prefix.
 * Use this in route handlers that return HTML pages.
 *
 * Accepts a JSX element (JSXNode) or string. Arrays and Promises
 * are not supported — pass a single JSX node.
 *
 * @example
 * ```ts
 * return c.html(renderPage(<MyPage />));
 * ```
 */
export function renderPage(content: Child): string {
    // JSXNode has a proper toString() that renders to HTML.
    // Strings and numbers are also fine.
    const str =
        typeof content === "string"
            ? content
            : (content as { toString(): string }).toString();
    return `<!DOCTYPE html>\n${str}`;
}

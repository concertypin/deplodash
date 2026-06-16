/**
 * Login page component.
 * Shows a "Login with GitHub" button when user is not authenticated.
 */

import type { FC } from "hono/jsx";
import { Layout } from "./Layout";

interface LoginPageProps {
    redirectUrl: string;
}

export const LoginPage: FC<LoginPageProps> = ({ redirectUrl }) => (
    <Layout title="Deplodash — Login">
        <div class="hero min-h-screen">
            <div class="hero-content text-center">
                <div class="max-w-md">
                    <div class="mb-6">
                        <i
                            data-lucide="bot"
                            class="w-16 h-16 mx-auto text-primary"
                        />
                    </div>
                    <h1 class="text-3xl font-bold mb-2">Deplodash</h1>
                    <p class="text-base-content/60 mb-8">
                        GitHub App Token Service — Issue scoped installation
                        tokens for AI agents.
                    </p>
                    <a href={redirectUrl} class="btn btn-primary btn-lg gap-2">
                        <i data-lucide="github" class="w-5 h-5" />
                        Login with GitHub
                    </a>
                </div>
            </div>
        </div>
    </Layout>
);

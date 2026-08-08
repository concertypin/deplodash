/* v8 ignore file -- @preserve */
import "@/style.css";
import App from "@/App.svelte";
import { mount } from "svelte";

// Promise.withResolvers is not available in browsers older than Chrome 119 /
// Firefox 121 / Safari 17.4, which the Vite 8 build target still includes.
// Provide a small fallback so HomePage's paced revoke delay keeps working.
if (typeof Promise.withResolvers !== "function") {
    Promise.withResolvers = function withResolvers<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

const target = document.getElementById("app");
if (!target) {
    throw new Error("Failed to find target element with id 'app'");
}
const app = mount(App, { target });
export default app;

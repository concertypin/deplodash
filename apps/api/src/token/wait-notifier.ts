/**
 * In-memory module-level pubsub for Long Polling within the same isolate.
 * Cloudflare Workers doesn't support BroadcastChannel natively in the same way browsers do,
 * but requests hitting the same isolate can share module-level state.
 */

type WaitCallback = () => void;

// Key format: `${repo}:${agentId}`
const pendingWaiters = new Map<string, Array<WaitCallback>>();

function getKey(repo: string, agentId: string): string {
    return `${repo}:${agentId}`;
}

export function addWaiter(
    repo: string,
    agentId: string,
    callback: WaitCallback
): () => void {
    const key = getKey(repo, agentId);
    if (!pendingWaiters.has(key)) {
        pendingWaiters.set(key, []);
    }
    const waiters = pendingWaiters.get(key)!;
    waiters.push(callback);

    // Return an unsubscribe function
    return () => {
        const currentWaiters = pendingWaiters.get(key);
        if (currentWaiters) {
            const index = currentWaiters.indexOf(callback);
            if (index !== -1) {
                currentWaiters.splice(index, 1);
            }
            if (currentWaiters.length === 0) {
                pendingWaiters.delete(key);
            }
        }
    };
}

export function notifyWaiters(repo: string, agentId: string): void {
    const key = getKey(repo, agentId);
    const waiters = pendingWaiters.get(key);
    if (waiters) {
        // Copy the array to safely iterate and call them
        const callbacks = [...waiters];
        pendingWaiters.delete(key); // clear immediately so they don't fire twice
        for (const cb of callbacks) {
            try {
                cb();
            } catch (e) {
                console.error("Error notifying waiter", e);
            }
        }
    }
}

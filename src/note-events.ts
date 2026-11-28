/**
 * Note change events for plugins (CouchDB mode).
 *
 * Every change the server applies to its search index from the CouchDB
 * changes feed (the startup catch-up, the live watcher and the pre-search
 * catch-up) is also emitted here, so a plugin can react to edits that reach
 * CouchDB without a tool call: an edit made in Obsidian and replicated by
 * LiveSync, or a write by another server instance.
 *
 * What a subscriber can rely on, and what it cannot:
 * - A change is a trigger, not the truth: the same change can arrive twice
 *   (a catch-up and the watcher overlap), a burst of edits can arrive as one
 *   change (the feed reports only a document's latest revision), and changes
 *   applied before the plugin subscribed (the startup catch-up runs while
 *   plugins load) are never replayed. A subscriber re-reads the note and
 *   keeps its own record of what it already handled.
 * - `content` is the note's text as the index saw it, `null` for a deletion.
 * - Subscribers run synchronously, in the order they subscribed, on the
 *   index's own code path. A subscriber that throws or returns a rejected
 *   promise is logged and never reaches the index; one that needs to do I/O
 *   starts it and returns.
 */

export interface NoteChange {
    path: string;
    content: string | null;
}

export type NoteChangeListener = (change: NoteChange) => unknown;

export class NoteChangeHub {
    private readonly listeners: { listener: NoteChangeListener; owner: string }[] = [];

    constructor(private readonly warn: (message: string) => void = (m) => console.warn(m)) {}

    get size(): number {
        return this.listeners.length;
    }

    subscribe(listener: NoteChangeListener, owner = "plugin"): void {
        this.listeners.push({ listener, owner });
    }

    emit(path: string, content: string | null): void {
        if (this.listeners.length === 0) return;
        const change: NoteChange = { path, content };
        for (const { listener, owner } of this.listeners) {
            try {
                const result = listener(change);
                // Caught here, in the same tick: an unhandled rejection would stop the process.
                if (result && typeof (result as Promise<unknown>).then === "function") {
                    (result as Promise<unknown>).then(undefined, (err) => this.warn(`[${owner}] note change handler failed for ${path}: ${(err as Error)?.message ?? err}`));
                }
            } catch (err) {
                this.warn(`[${owner}] note change handler failed for ${path}: ${(err as Error)?.message ?? err}`);
            }
        }
    }
}

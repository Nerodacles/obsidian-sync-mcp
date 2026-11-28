// Server-wide read scope (READ_FOLDERS env var).
//
// READ_FOLDERS is a comma-separated allow-list of vault-relative paths, e.g.
// `Shared,Projects/public,welcome.md`. An entry covers itself and everything
// under it, so a folder shows its whole subtree and a note path shows that one
// note. Everything else is hidden from every tool: a hidden note reads exactly
// like a missing one, and nothing under a hidden path can be written.
//
// Root-level notes are hidden unless listed one by one; `/` is refused,
// because "the whole vault" is what leaving READ_FOLDERS unset already means.
//
// The filter sits at the backend boundary (readScopedVault) and on the search
// index (SearchIndex.restrictTo), so every tool, the change feed, the
// pre-search catch-up and plugins see the same filtered vault.

import type { VaultBackend } from "./vault-backend.js";
import { fold, isReadable, normalizePath, checkWrite, type ReadScope, type WriteScope } from "./write-scope.js";

export { isReadable, describeReadScope, type ReadScope } from "./write-scope.js";

/**
 * Parse the READ_FOLDERS env var. Unset means the whole vault is readable
 * (null). Throws when it is set but lists nothing, on `/`, on a `:` (Obsidian
 * forbids it in names, so it is a WRITE_FOLDERS-style permission that means
 * nothing here), on traversal or a malformed entry, and on an entry listed
 * twice: a typo in a setting that hides notes must stop the server, not show
 * the vault.
 */
export function parseReadFolders(raw: string | undefined): ReadScope {
    if (raw === undefined) return null;
    const entries: string[] = [];
    const seen = new Map<string, string>();
    for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
        if (entry.includes(":")) {
            throw new Error(`READ_FOLDERS: '${entry}' has a ':'. List folders or notes only; there are no read permissions.`);
        }
        if (entry.includes("\\")) throw new Error(`READ_FOLDERS: '${entry}' uses a backslash; separate folders with '/'.`);
        const trimmed = entry.replace(/^\/+|\/+$/g, "");
        if (trimmed === "") {
            throw new Error(`READ_FOLDERS: '${entry}' is the whole vault. Unset READ_FOLDERS to make everything readable.`);
        }
        const normalized = normalizePath(trimmed);
        if (normalized === null || normalized !== trimmed || trimmed.split("/").some((s) => s === "" || s === ".")) {
            throw new Error(`READ_FOLDERS: '${entry}' has an empty, '.' or '..' folder segment.`);
        }
        const key = fold(trimmed);
        const earlier = seen.get(key);
        if (earlier !== undefined) {
            const why = earlier === trimmed ? "" : ` (also as '${earlier}'; names are compared ignoring case)`;
            throw new Error(`READ_FOLDERS: '${trimmed}' is listed more than once${why}.`);
        }
        seen.set(key, trimmed);
        entries.push(trimmed);
    }
    if (entries.length === 0) {
        throw new Error("READ_FOLDERS is set but lists nothing. Unset it to make the whole vault readable.");
    }
    // An entry inside another adds nothing; refuse it so the list reads as what it does.
    for (const e of entries) {
        const outer = entries.find((o) => o !== e && e.startsWith(o + "/"));
        if (outer) throw new Error(`READ_FOLDERS: '${e}' is inside '${outer}', which already shows it.`);
    }
    return entries;
}

/**
 * Startup errors for other settings that would name a hidden path in a tool
 * description or a refusal: a WRITE_FOLDERS folder or a SEARCH_DEFAULT_EXCLUDE
 * folder outside the read scope. Such a folder could never be written or
 * searched anyway. The root rule `/` names nothing, and a folder that is an
 * ancestor of a readable entry is already visible from list_folders.
 */
export function readScopeConflicts(readScope: ReadScope, writeScope: WriteScope, searchExclude: readonly string[]): string[] {
    if (readScope === null) return [];
    const visibleName = (folder: string) =>
        folder === "" || isReadable(folder, readScope) || readScope.some((e) => e.startsWith(folder + "/"));
    const errors: string[] = [];
    for (const rule of writeScope ?? []) {
        if (!visibleName(rule.folder)) {
            errors.push(`WRITE_FOLDERS: '${rule.folder}' is outside READ_FOLDERS, so it can't be written; add it to READ_FOLDERS or remove it.`);
        }
    }
    for (const folder of searchExclude) {
        const f = folder.replace(/^\/+|\/+$/g, "");
        if (!visibleName(f)) {
            errors.push(`SEARCH_DEFAULT_EXCLUDE: '${f}' is outside READ_FOLDERS, so search never sees it; remove it.`);
        }
    }
    return errors;
}

/**
 * A note's outgoing links without those that name a hidden path. A link with
 * a folder in it is judged by that path, whether or not a note exists there,
 * so the list can't tell a hidden note from a missing one. A bare name
 * (`[[plan]]`) names no folder and is kept as written: it reads like any other
 * link the server can't resolve, and the note's own text shows it anyway.
 */
export function visibleLinks(links: readonly string[], scope: ReadScope): string[] {
    return links.filter((link) => !link.includes("/") || isReadable(link, scope));
}

/**
 * A backend that shows only the paths inside `scope`. Hidden notes and
 * attachments read as absent (null, or left out of listings), their changes
 * never reach a change-feed callback, and every write to one throws before the
 * inner backend is asked anything, so neither answer depends on the path
 * existing. Tools check the scope themselves first (checkWrite) to give the
 * WRITE_FOLDERS-style refusal; this is the backstop for any other path.
 */
export function readScopedVault(inner: VaultBackend, scope: readonly string[]): VaultBackend {
    const visible = (path: string) => isReadable(path, scope);
    const guard = (path: string) => {
        const refusal = checkWrite(path, "update", null, scope);
        if (refusal) throw new Error(refusal);
    };
    return {
        init: () => inner.init(),
        close: () => inner.close(),
        readNote: async (path) => (visible(path) ? inner.readNote(path) : null),
        readNoteRevision: inner.readNoteRevision
            ? async (path) => (visible(path) ? inner.readNoteRevision!(path) : null)
            : undefined,
        getMetadata: async (path) => {
            if (!visible(path)) return null;
            const meta = await inner.getMetadata(path);
            return meta && { ...meta, links: visibleLinks(meta.links, scope) };
        },
        listNotes: async (folder) => (await inner.listNotes(folder)).filter(visible),
        listNotesWithMtime: async (folder) => (await inner.listNotesWithMtime(folder)).filter((n) => visible(n.path)),
        getAttachmentInfo: async (path) => (visible(path) ? inner.getAttachmentInfo(path) : null),
        listAttachments: inner.listAttachments
            ? async () => (await inner.listAttachments!()).filter((a) => visible(a.path))
            : undefined,
        watchChanges: inner.watchChanges
            ? (callback, onAttachment) =>
                inner.watchChanges!(
                    (path, content, mtime, seq) => { if (visible(path)) callback(path, content, mtime, seq); },
                    onAttachment ? (path, info) => { if (visible(path)) onAttachment(path, info); } : undefined,
                )
            : undefined,
        catchUp: inner.catchUp
            ? (since, callback, onBatch, stats, onAttachment) =>
                inner.catchUp!(
                    since,
                    (path, content, mtime) => { if (visible(path)) callback(path, content, mtime); },
                    onBatch,
                    stats,
                    onAttachment ? (path, info) => { if (visible(path)) onAttachment(path, info); } : undefined,
                )
            : undefined,
        listConflicts: inner.listConflicts
            ? async (folder) => {
                const listing = await inner.listConflicts!(folder);
                return { ...listing, conflicts: listing.conflicts.filter((c) => visible(c.path)) };
            }
            : undefined,
        getConflict: inner.getConflict
            ? async (path) => (visible(path) ? inner.getConflict!(path) : null)
            : undefined,
        writeNote: async (path, content, options) => { guard(path); return inner.writeNote(path, content, options); },
        updateNote: inner.updateNote
            ? async (path, apply, options) => { guard(path); return inner.updateNote!(path, apply, options); }
            : undefined,
        resolveConflict: inner.resolveConflict
            ? async (path, leaves, resolution) => { guard(path); return inner.resolveConflict!(path, leaves, resolution); }
            : undefined,
        deleteNote: async (path) => { guard(path); return inner.deleteNote(path); },
        moveNote: async (from, to) => { guard(from); guard(to); return inner.moveNote(from, to); },
        writeAttachment: async (path, data, options) => { guard(path); return inner.writeAttachment(path, data, options); },
        deleteAttachment: async (path) => { guard(path); return inner.deleteAttachment(path); },
        moveAttachment: async (from, to, options) => { guard(from); guard(to); return inner.moveAttachment(from, to, options); },
    };
}

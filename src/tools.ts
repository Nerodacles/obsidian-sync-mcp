import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import { ConflictChangedError, ConflictLeafUnreadableError, NoteExistsError, NoteNotFoundError, RevisionMismatchError, UpdateRetriesExhaustedError, type ConflictLeaf, type VaultBackend } from "./vault-backend.js";
import { diffLines, unifiedDiff } from "./line-diff.js";
import { termWords, type SearchIndex } from "./search.js";
import { allowedActions, checkWrite, describeFolders, describeWriteScope, type WriteScope } from "./write-scope.js";
import { describeListing, describeNoMatch } from "./list-format.js";
import { describeExcluded, describeHits, describeQuery, describeSync, type SyncStatus } from "./search-format.js";
import { fingerprint, OP_ID_PATTERN, type OpStore } from "./op-store.js";
import { appendToSection, EditRefused, setProperties } from "./structured-edits.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

/** Runs a CouchDB catch-up before a search; undefined in local (VAULT_PATH) mode. */
export type SyncBeforeSearch = () => Promise<{ unreadable: number; error?: string }>;

export const SEARCH_MAX_HITS = 20;
/** Each term is one more regex pass over every note (synchronous), so the count is capped. */
export const SEARCH_MAX_TERMS = 20;
/** Each term is compiled into a regex; a very long one overflows the stack (~10 KB with flags iu) or blocks the event loop, so its length is capped. */
export const SEARCH_MAX_TERM_LENGTH = 200;
/** Each distinct word is one more regex pass over every note, so their number across all terms is capped too. */
export const SEARCH_MAX_WORDS = 100;

/** Trim, drop empty terms, cut each to SEARCH_MAX_TERM_LENGTH and clamp to SEARCH_MAX_TERMS — a backstop behind the schema's .max(). */
export function cleanSearchTerms(terms: string[] | undefined): string[] {
    return (terms ?? [])
        .map((t) => t.trim().slice(0, SEARCH_MAX_TERM_LENGTH))
        .filter((t) => t.length > 0)
        .slice(0, SEARCH_MAX_TERMS);
}

const WRITE_TOOLS = ["write_note", "edit_note", "set_properties", "append_to_section", "delete_note", "move_note", "resolve_conflict"] as const;

/**
 * edit_note rounds when another writer changes the note between its read and
 * its write (CouchDB mode): at least this many, then more until
 * EDIT_MIN_RETRY_MS has passed or 5 x this many rounds have run, whichever
 * comes first (on a fast database usually the round cap). write_note uses the
 * same budget to replace an existing note. Edits queued on one server are
 * written together (see CouchVault.updateNote), so rounds are lost only to
 * other instances. A refused edit answers "Failed to edit note" and writes
 * nothing; it is never silently dropped.
 */
export const EDIT_MAX_ATTEMPTS = 10;
/** edit_note keeps retrying past EDIT_MAX_ATTEMPTS until this much time has passed or 5 x the attempts have run. */
export const EDIT_MIN_RETRY_MS = 3000;

export const NO_REVISIONS_MESSAGE =
    "expected_revision needs CouchDB mode: this vault has no revisions. Nothing was written.";

export const CONFLICTS_NEED_COUCHDB_MESSAGE =
    "Conflicts exist only in CouchDB mode: this vault has no revisions, so a note can't have two live versions.";

/**
 * First line of read_note and get_note_metadata when the note has other live
 * revision leaves in CouchDB. Agents can match on the leading "CONFLICT: ".
 */
export function conflictLine(others: number): string {
    return `CONFLICT: ${others} other live version${others === 1 ? "" : "s"} of this note; see get_conflict.`;
}

/**
 * get_conflict output bound: the diffs of all other versions together stay
 * under this many characters (shared equally between them), so the answer
 * stays inline in clients that move large tool results to a file.
 */
export const GET_CONFLICT_MAX_DIFF_CHARS = 30_000;
/** Diff lines longer than this are cut. */
export const GET_CONFLICT_MAX_LINE_CHARS = 500;

/** A Markdown fence longer than any backtick run in the text. */
function fenceFor(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    return "`".repeat(Math.max(3, longest + 1));
}

function describeLeaf(leaf: ConflictLeaf): string {
    const when = leaf.mtime ? `modified ${new Date(leaf.mtime).toISOString()}` : "modified (unknown)";
    const notes = [leaf.deleted ? "a deletion (LiveSync marked the note deleted in this version)" : "", leaf.content === null ? "its text could not be read" : ""].filter(Boolean);
    return `${leaf.revision}, ${when}, ${leaf.size} bytes${notes.length ? `; ${notes.join("; ")}` : ""}`;
}


/** Apply one edit_note operation to a note's text; throws EditRefused when it can't be applied. */
export function applyEdit(existing: string, op: "append" | "prepend" | "replace", newContent: string, oldText?: string): string {
    if (op === "replace") {
        if (!oldText) throw new EditRefused("old_text is required for replace operation.");
        const idx = existing.indexOf(oldText);
        if (idx === -1) throw new EditRefused("old_text not found in note.");
        if (existing.indexOf(oldText, idx + 1) !== -1) {
            throw new EditRefused("old_text matches multiple times. Provide a longer, unique string.");
        }
        return existing.slice(0, idx) + newContent + existing.slice(idx + oldText.length);
    }
    if (op === "prepend") {
        // Insert after frontmatter if present
        const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
        if (fmMatch) {
            const afterFm = fmMatch[0].length;
            return existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
        }
        return newContent + "\n" + existing;
    }
    return existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
}

export type WriteMode = "upsert" | "create" | "update";

/**
 * The write mode WRITE_FOLDERS allows for a whole-note write at `path`, or the
 * refusal to show. Whether it creates or updates depends on the note existing,
 * so the backend decides in the same step as the write.
 */
export function chooseWriteMode(path: string, writeFolders: WriteScope): { mode: WriteMode } | { denied: string } {
    const allow = allowedActions(path, writeFolders);
    const canCreate = allow.has("create");
    const canUpdate = allow.has("update");
    if (!canCreate && !canUpdate) return { denied: checkWrite(path, "create", writeFolders)! };
    return { mode: canCreate && canUpdate ? "upsert" : canCreate ? "create" : "update" };
}

/**
 * Change a note's text with `apply` the way edit_note does: in CouchDB mode
 * revision-checked and re-applied when another writer got in first, else read
 * then written back without recreating a note deleted in between. Returns the
 * new text, or null when the note doesn't exist. The caller checks
 * WRITE_FOLDERS ("update") first. Shared with plugins.
 */
export async function editNoteText(vault: VaultBackend, path: string, apply: (content: string) => string): Promise<string | null> {
    if (vault.updateNote) {
        try {
            return (await vault.updateNote(path, apply, { maxAttempts: EDIT_MAX_ATTEMPTS, minRetryMs: EDIT_MIN_RETRY_MS })).content;
        } catch (err) {
            if (err instanceof NoteNotFoundError) return null;
            throw err;
        }
    }
    const existing = await vault.readNote(path);
    if (existing === null) return null;
    const updated = apply(existing);
    let ok: boolean;
    try {
        ok = await vault.writeNote(path, updated, { mode: "update" });
    } catch (err) {
        if (err instanceof NoteNotFoundError) return null;
        throw err;
    }
    if (!ok) throw new Error(`Failed to edit note: ${path}`);
    return updated;
}

function describeMismatch(err: RevisionMismatchError): string {
    return `Revision mismatch: ${err.path} is at revision ${err.current}, not ${err.expected}. Nothing was written; read the note again and reapply your change.`;
}

// Shaped like a CouchDB revision (`<generation>-<hex>`): the value is echoed in
// the mismatch answer, so an empty, huge or multi-line value is refused here.
const expectedRevisionParam = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[1-9]\d*-[0-9a-f]+$/, "expected_revision must be a revision from read_note or get_note_metadata, like 12-3f9c...")
    .optional()
    .describe("Optional, CouchDB mode: the revision from read_note or get_note_metadata. The write only happens if the note is still at that revision; otherwise nothing is written and the current revision is returned.");

export const NO_OP_STORE_MESSAGE = "op_id needs OPS_DATABASE (CouchDB mode): this server keeps no operation records. Nothing was written.";

const opIdParam = z
    .string()
    .regex(OP_ID_PATTERN, "op_id: 1-128 characters from A-Z a-z 0-9 . _ : -")
    .optional()
    .describe("Optional idempotency key, unique per intended change (e.g. a UUID). A retry with the same op_id returns the first call's answer instead of writing again.");

/**
 * Run a write tool at most once per op_id: the first call claims the id and
 * stores its answer; a repeat gets that answer back without running.
 */
async function runOnce(opStore: OpStore, tool: string, args: Record<string, unknown>, run: () => Promise<unknown>): Promise<unknown> {
    const opId = args.op_id as string;
    const claim = await opStore.claim(opId, fingerprint(tool, args));
    if (claim.state === "done") return claim.result;
    if (claim.state === "mismatch") return `op_id ${opId} was already used for a different call (another tool or other arguments). Nothing was written; use a new op_id.`;
    if (claim.state === "pending") {
        return `op_id ${opId} was claimed at ${new Date(claim.startedAt).toISOString()} and has not finished: it is still running, or it was interrupted and its outcome is unknown. ` +
            "Nothing was done by this call. Read the note to see whether the change is there before retrying with a new op_id.";
    }
    // If the call throws, the record stays pending: the write may or may not have happened.
    const result = await run();
    await opStore.complete(opId, claim.token, typeof result === "string" ? result : JSON.stringify(result));
    return result;
}

// Claude Code persists any MCP tool result above ~50 000 characters to a file
// and hands the model a 2 kB preview instead of the text. A tool can raise its
// own threshold (hard ceiling 500 000) by declaring
// `_meta["anthropic/maxResultSizeChars"]` in its tools/list entry; text from
// such a tool is then also exempt from MAX_MCP_OUTPUT_TOKENS. See
// https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool
// read_note returns whole notes, so it declares 100 000: enough for a large
// note to arrive in one piece, small enough to keep one read inside a sane
// context budget. Other clients ignore the key.
export const READ_NOTE_MAX_RESULT_SIZE_CHARS = 100_000;

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: WriteScope = null,
    syncBeforeSearch?: SyncBeforeSearch,
    opStore?: OpStore,
    /** SEARCH_DEFAULT_EXCLUDE, parsed by parseSearchExclude: folders search_notes leaves out unless asked for. */
    searchExclude: string[] = [],
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${describeFolders(writeFolders)}.`);
    }
    const writeScopeNote = describeWriteScope(writeFolders);

    /**
     * Change an existing note with `apply`, which gets its current text and
     * returns the new one, or throws EditRefused. In CouchDB mode the change is
     * applied to the text it was read with and written only if the note is
     * still at that revision; when another writer got in between, it is
     * re-applied to the new text, so nobody's change is lost. `label` names the
     * change in the answer: "Note edited (<label>)".
     */
    async function editExisting(tool: string, path: string, label: string, apply: (existing: string) => string, expectedRevision?: string): Promise<string> {
        if (vault.updateNote) {
            try {
                const { content: updated, revision, attempts } = await vault.updateNote(path, apply, {
                    expectedRevision,
                    maxAttempts: EDIT_MAX_ATTEMPTS,
                    minRetryMs: EDIT_MIN_RETRY_MS,
                });
                if (debugLogging && attempts > 1) console.log(`[tool] ${tool} applied after ${attempts} attempts`);
                searchIndex.update(path, updated, Date.now());
                return `Note edited (${label}): ${path}\nRevision: ${revision}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
            } catch (err) {
                if (err instanceof EditRefused) return err.message;
                if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                if (err instanceof RevisionMismatchError) return describeMismatch(err);
                if (err instanceof UpdateRetriesExhaustedError) {
                    return `Failed to edit note: ${path} kept changing during ${err.attempts} attempts. Nothing was written; try again.`;
                }
                throw err;
            }
        }
        if (expectedRevision !== undefined) return NO_REVISIONS_MESSAGE;

        const existing = await vault.readNote(path);
        if (existing === null) {
            return `Note not found: ${path}`;
        }
        let updated: string;
        try {
            updated = apply(existing);
        } catch (err) {
            if (err instanceof EditRefused) return err.message;
            throw err;
        }

        let ok: boolean;
        try {
            // "update": a note deleted since it was read isn't recreated.
            ok = await vault.writeNote(path, updated, { mode: "update" });
        } catch (err) {
            if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
            throw err;
        }
        if (!ok) {
            return `Failed to edit note: ${path}`;
        }
        searchIndex.update(path, updated, Date.now());
        const deepLink = makeDeepLink(vaultName, path);
        return `Note edited (${label}): ${path}\n[Open in Obsidian](${deepLink})`;
    }
    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        // A plugin tool marked `writes: true` is treated like a built-in write tool.
        const pluginWrite = tool.writes === true;
        delete tool.writes;
        if (!readOnly && (pluginWrite || (WRITE_TOOLS as readonly string[]).includes(tool.name))) {
            tool.parameters = tool.parameters.extend({ op_id: opIdParam });
            const write = tool.execute;
            tool.execute = async (args: any, ctx: any) => {
                if (args.op_id === undefined) return write(args, ctx);
                if (!opStore) return NO_OP_STORE_MESSAGE;
                const { op_id: _opId, ...rest } = args;
                return runOnce(opStore, tool.name, args, () => write(rest, ctx));
            };
        }
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const result = await original(args, ctx);
            if (debugLogging) console.log(`[tool] ${tool.name} → ${((performance.now() - start)).toFixed(0)}ms`);
            return result;
        };
        return _addTool(tool);
    };
    server.addTool({
        name: "read_note",
        description:
            "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian; in CouchDB mode also the note's revision, which write_note and edit_note accept as expected_revision. " +
            "For a path that doesn't exist, it says so and lists notes with that file name or alias elsewhere, if any. " +
            "When the note has other live versions in CouchDB (a sync conflict), the answer starts with a line 'CONFLICT: N other live versions of this note; see get_conflict.' and the text shown is only the version CouchDB picked.",
        _meta: { "anthropic/maxResultSizeChars": READ_NOTE_MAX_RESULT_SIZE_CHARS },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async ({ path }) => {
            // Text and revision come from one fetch, so the revision names exactly this text.
            const revised = vault.readNoteRevision ? await vault.readNoteRevision(path) : null;
            const content = revised ? revised.content : await vault.readNote(path);
            if (content === null) {
                const suggestions = searchIndex.suggestByName(path);
                if (suggestions.length === 0) return `Note not found: ${path}`;
                const lines = suggestions.map((s) => `- ${s.path} (${s.alias !== undefined ? `alias "${s.alias}"` : "same file name"})`);
                return [`Note not found: ${path}`, "Did you mean:", ...lines].join("\n");
            }
            const deepLink = makeDeepLink(vaultName, path);
            const revisionLine = revised ? `\nRevision: ${revised.revision}` : "";
            const conflict = revised?.conflicts?.length ? `${conflictLine(revised.conflicts.length)}\n` : "";
            return `${conflict}[Open in Obsidian](${deepLink})${revisionLine}\n\n---\n\n${content}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
            expected_revision: expectedRevisionParam,
            create_only: z
                .boolean()
                .optional()
                .describe("Only create: if a note already exists at the path, write nothing and say so. Default false (create or replace)."),
        }),
        execute: async ({ path, content, expected_revision, create_only }) => {
            if (expected_revision !== undefined && create_only) return "expected_revision names an existing note, so it can't be combined with create_only. Nothing was written.";
            if (expected_revision !== undefined) {
                // A revision names an existing note, so this is an update.
                const denied = checkWrite(path, "update", writeFolders);
                if (denied) return denied;
                if (!vault.updateNote) return NO_REVISIONS_MESSAGE;
                try {
                    const { revision } = await vault.updateNote(path, () => content, { expectedRevision: expected_revision });
                    searchIndex.update(path, content, Date.now());
                    return `Note saved: ${path}\nRevision: ${revision}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
                } catch (err) {
                    if (err instanceof RevisionMismatchError) return describeMismatch(err);
                    if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                    throw err;
                }
            }
            // Whether this is a create or an update depends on the note existing,
            // so pass what's allowed down and let the backend decide in the same
            // step as the write.
            const allow = allowedActions(path, writeFolders);
            const canCreate = allow.has("create");
            const canUpdate = allow.has("update") && !create_only;
            if (create_only && !canCreate) return checkWrite(path, "create", writeFolders)!;
            if (!canCreate && !canUpdate) return checkWrite(path, "create", writeFolders)!;
            const mode = canCreate && canUpdate ? "upsert" : canCreate ? "create" : "update";
            let ok: boolean;
            try {
                // CouchDB mode replaces an existing note with a revision-checked put,
                // retried within edit_note's budget.
                ok = await vault.writeNote(path, content, { mode, maxAttempts: EDIT_MAX_ATTEMPTS, minRetryMs: EDIT_MIN_RETRY_MS });
            } catch (err) {
                if (err instanceof NoteExistsError) {
                    if (create_only) return `Note already exists: ${path}. Nothing was written (create_only); choose a new path.`;
                    return `${checkWrite(path, "update", writeFolders)} The note already exists; choose a new path.`;
                }
                if (err instanceof NoteNotFoundError) return checkWrite(path, "create", writeFolders)!;
                if (err instanceof UpdateRetriesExhaustedError) {
                    return `Failed to write note: ${path} kept changing during ${err.attempts} attempts. Nothing was written; try again.`;
                }
                throw err;
            }
            if (!ok) {
                return `Failed to write note: ${path}`;
            }
            searchIndex.update(path, content, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in the vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe("Max number of notes to return. Default 100."),
        }),
        execute: async ({ folder, name, tag, sort_by, modified_after, limit }) => {
            // Use search index (works with encrypted vaults), fall back to vault
            let notes = searchIndex.listWithMtime(folder);
            let vaultTotal: number | null = searchIndex.size;
            let servedByVault = false;
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
                servedByVault = notes.length > 0;
                // The fallback only tells us the vault total when it was unscoped.
                if (vaultTotal === 0) vaultTotal = folder ? null : notes.length;
            }
            const folderTotal = folder ? notes.length : null;
            const filters: string[] = [];
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
                filters.push(`name="${name}"`);
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
                filters.push(`tag="${tag}"`);
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
                filters.push(`modified_after="${modified_after}"`);
            }
            const index = { state: searchIndex.state, size: searchIndex.size, servedByVault };
            if (notes.length === 0) {
                return describeNoMatch({ vaultTotal, folder, folderTotal, filters, index });
            }
            const sortBy = sort_by === "modified" ? "modified" : "name";
            if (sortBy === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const header = describeListing({
                shown: capped.length,
                matched: total,
                vaultTotal,
                folder,
                folderTotal,
                filters,
                sortBy,
                limit: cap,
                omitted: notes.slice(cap).map((n) => n.path),
                index,
            });
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            return [header, ...lines].join("\n");
        },
    });

    server.addTool({
        name: "search_notes",
        description:
            "Search note contents for terms, case-insensitive.\n" +
            "Paths, frontmatter titles, aliases and the summary and case properties are searched first and such hits rank on top, marked [path/title]; content hits follow. " +
            "Returns paths with one context line each, never the note body: call read_note on a hit before relying on it. " +
            "Give `terms` (a note matches when ANY term matches — OR, so list synonyms, field names and other-language wordings; ranked by how many terms match). " +
            "A term matches when ALL its words (split at spaces and hyphens) occur as whole words, in any order: 'garden plan' finds 'plan for the garden', 'ups' does not find 'backups', and 'site-loss' equals 'site loss'. " +
            "Filters: folder, tag, modified_after. " +
            "The first line of every response is the index status: the CouchDB sequence the index is caught up with after a catch-up run just before the search, " +
            "the server time (local zone and UTC), its age in minutes, how many notes carry content, and any documents that could not be read" +
            (searchExclude.length > 0
                ? `; folders ${searchExclude.join(", ")} are left out unless \`folder\` points inside one, and the status line says how many matching notes they held.`
                : "."),
        parameters: z.object({
            terms: z
                .array(z.string().max(SEARCH_MAX_TERM_LENGTH))
                .max(SEARCH_MAX_TERMS)
                .optional()
                .describe(`Case-insensitive words or groups of words, at most ${SEARCH_MAX_TERMS} of at most ${SEARCH_MAX_TERM_LENGTH} characters each; a note matches when any term matches, and a term matches when all its words occur. E.g. ['drag i kanban', 'kanban', 'labels på kategori'].`),
            folder: z
                .string()
                .optional()
                .describe("Folder to search in, e.g. 'projects'. Omit for the whole vault."),
            tag: z
                .string()
                .optional()
                .describe("Only notes carrying this tag, e.g. 'project'."),
            modified_after: z
                .string()
                .optional()
                .describe("Only notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe(`Max hits to return, default and maximum ${SEARCH_MAX_HITS}.`),
        }),
        execute: async ({ terms, folder, tag, modified_after, limit }) => {
            const cleanTerms = cleanSearchTerms(terms);
            if (cleanTerms.length === 0) {
                return "Give at least one term.";
            }
            const words = new Set(cleanTerms.flatMap(termWords)).size;
            if (words > SEARCH_MAX_WORDS) {
                return `Too many words: ${words} distinct words across all terms, at most ${SEARCH_MAX_WORDS}. Use fewer or shorter terms.`;
            }
            let modifiedAfter: number | undefined;
            if (modified_after) {
                modifiedAfter = new Date(modified_after).getTime();
                if (isNaN(modifiedAfter)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
            }
            const cap = Math.max(1, Math.min(SEARCH_MAX_HITS, limit ?? SEARCH_MAX_HITS));

            // Catch up first, so a hit can never predate the vault (see main.ts).
            const sync = syncBeforeSearch ? await syncBeforeSearch() : { unreadable: 0 };
            const status: SyncStatus = {
                mode: syncBeforeSearch ? "couchdb" : "local",
                state: searchIndex.state,
                seq: searchIndex.since,
                syncedAt: searchIndex.lastSyncAt,
                now: Date.now(),
                notes: searchIndex.size,
                withContent: searchIndex.contentCount,
                unreadable: sync.unreadable,
                error: sync.error,
            };
            const { hits, total, excluded } = searchIndex.search({ terms: cleanTerms, folder, tag, modifiedAfter, exclude: searchExclude, limit: cap });
            const query = describeQuery(cleanTerms);
            const excludedNote = describeExcluded(searchExclude, folder, excluded);
            return `${describeSync(status)}${excludedNote}\n${describeHits(hits, total, query, (p) => makeDeepLink(vaultName, p))}`;
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in the vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note counts.",
        parameters: z.object({}),
        execute: async () => {
            let paths = searchIndex.listPaths();
            if (paths.length === 0) {
                paths = await vault.listNotes();
            }
            const folders = new Map<string, number>();
            for (const p of paths) {
                const lastSlash = p.lastIndexOf("/");
                if (lastSlash === -1) {
                    folders.set("(root)", (folders.get("(root)") ?? 0) + 1);
                } else {
                    const folder = p.slice(0, lastSlash);
                    folders.set(folder, (folders.get(folder) ?? 0) + 1);
                    // Ensure all parent folders appear in the list
                    let parent = folder;
                    while (parent.includes("/")) {
                        parent = parent.slice(0, parent.lastIndexOf("/"));
                        if (!folders.has(parent)) folders.set(parent, 0);
                    }
                }
            }
            if (folders.size === 0) {
                return "Vault is empty.";
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n");
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in the vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({}),
        execute: async () => {
            const tags = searchIndex.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault.";
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });



    if (!readOnly) server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            content: z.string().describe("Text to append, prepend, or use as replacement for old_text"),
            operation: z
                .enum(["append", "prepend", "replace"])
                .optional()
                .describe("'append' (default): add to end. 'prepend': add after frontmatter. 'replace': swap old_text with content."),
            old_text: z
                .string()
                .optional()
                .describe("Required for replace operation. Exact text to find and replace. Must match exactly once."),
            expected_revision: expectedRevisionParam,
        }),
        execute: async ({ path, content: newContent, operation, old_text, expected_revision }) => {
            const denied = checkWrite(path, "update", writeFolders);
            if (denied) return denied;
            const op = operation ?? "append";
            return await editExisting("edit_note", path, op, (existing) => applyEdit(existing, op, newContent, old_text), expected_revision);
        },
    });

    // A frontmatter value: text, number, true/false, or a list of those.
    const propertyScalar = z.union([z.string(), z.number(), z.boolean()]);

    if (!readOnly) server.addTool({
        name: "set_properties",
        description:
            "Set or remove frontmatter properties of a note without rewriting it. Only the keys named change; every other line of the frontmatter (comments, order, quoting) and the body stay exactly as they were. Adds the frontmatter if the note has none. Lists are written as YAML block lists. Refuses a note whose frontmatter isn't valid YAML." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'Projects/Garden plan.md'"),
            set: z
                .record(z.string(), z.union([propertyScalar, z.array(propertyScalar)]))
                .describe("Properties to add or change, e.g. {\"state\": \"done\", \"priority\": 2, \"tags\": [\"garden\"]}. Use {} to only remove."),
            remove: z.array(z.string()).optional().describe("Property names to delete. A name that isn't there is ignored."),
            expected_revision: expectedRevisionParam,
        }),
        execute: async ({ path, set, remove, expected_revision }) => {
            const denied = checkWrite(path, "update", writeFolders);
            if (denied) return denied;
            return await editExisting("set_properties", path, "set_properties", (existing) => setProperties(existing, set, remove), expected_revision);
        },
    });

    if (!readOnly) server.addTool({
        name: "append_to_section",
        description:
            "Append one line at the end of a section: under the first heading (any level) with this text, after the section's last line and before the next heading of the same or a higher level. Headings inside code blocks don't count. If the heading is missing, nothing is written unless create_heading is true, which adds '## heading' and the line at the end of the note. Concurrent appends to one section all land." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'Projects/Garden plan.md'"),
            heading: z.string().describe("The heading's text without the #s, e.g. 'Log' for '## Log'. Matched exactly, ignoring surrounding spaces."),
            line: z.string().describe("The line to add, e.g. '- 2026-04-01 seeds ordered'. One line: a line break inside is refused."),
            create_heading: z.boolean().optional().describe("Default false. When true and the heading is missing, add '## heading' with the line at the end of the note."),
        }),
        execute: async ({ path, heading, line, create_heading }) => {
            const denied = checkWrite(path, "update", writeFolders);
            if (denied) return denied;
            return await editExisting("append_to_section", path, "append_to_section", (existing) => appendToSection(existing, heading, line, create_heading ?? false));
        },
    });

    if (!readOnly) server.addTool({
        name: "delete_note",
        description: "Delete a note from the Obsidian vault." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
        }),
        execute: async ({ path }) => {
            const denied = checkWrite(path, "delete", writeFolders);
            if (denied) return denied;
            // The sync layer reports success even when nothing existed at the
            // path, so "Deleted" would claim a cleanup that never happened.
            // readNote returns "" for an empty note and null only when absent.
            const existing = await vault.readNote(path);
            if (existing === null) return `Note not found: ${path}`;
            const ok = await vault.deleteNote(path);
            if (ok) searchIndex.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically. Never replaces an existing note at the destination." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async ({ from, to }) => {
            // A move deletes at the source and creates at the destination.
            const denied = checkWrite(from, "delete", writeFolders) ?? checkWrite(to, "create", writeFolders);
            if (denied) return denied;
            const content = await vault.readNote(from);
            let ok: boolean;
            try {
                ok = await vault.moveNote(from, to);
            } catch (err) {
                if (err instanceof NoteExistsError) return `A note already exists at ${to}. Choose another path.`;
                throw err;
            }
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            searchIndex.remove(from);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) searchIndex.update(to, content, Date.now());
            const deepLink = makeDeepLink(vaultName, to);
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter, tags, outgoing links, backlinks (notes that link to this one), size, and timestamps. Use this to navigate the knowledge graph. " +
            "Starts with a 'CONFLICT: ' line, as read_note does, when the note has other live versions in CouchDB.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        execute: async ({ path }) => {
            const meta = await vault.getMetadata(path);
            if (!meta) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            const lines = [
                ...(meta.conflicts?.length ? [conflictLine(meta.conflicts.length)] : []),
                `**${path}**`,
                `Size: ${meta.size} bytes`,
                `Created: ${new Date(meta.ctime).toISOString()}`,
                `Modified: ${new Date(meta.mtime).toISOString()}`,
            ];
            if (meta.revision) lines.push(`Revision: ${meta.revision}`);
            if (meta.frontmatterError) {
                lines.push(`\nFrontmatter: not read, it isn't valid YAML (${meta.frontmatterError})`);
            }
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${v}`);
                }
            }
            if (meta.tags.length > 0) {
                lines.push(`\nTags: ${meta.tags.map((t) => `#${t}`).join(", ")}`);
            }
            if (meta.links.length > 0) {
                lines.push(`\nOutgoing links: ${meta.links.join(", ")}`);
            }
            const backlinks = searchIndex.getBacklinks(path);
            if (backlinks.length > 0) {
                lines.push(`\nBacklinks: ${backlinks.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${deepLink})`);
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "list_conflicts",
        description:
            "List notes that have more than one live version in CouchDB (a sync conflict, e.g. an Obsidian edit racing an agent edit), with how many other versions each has. " +
            "Reads no note text. Use get_conflict on a listed note to see the versions and resolve_conflict to settle it.",
        parameters: z.object({
            folder: z.string().optional().describe("Folder to list, e.g. 'projects'. Omit for the whole vault."),
        }),
        execute: async ({ folder }) => {
            if (!vault.listConflicts) return CONFLICTS_NEED_COUCHDB_MESSAGE;
            const { conflicts, unreadable } = await vault.listConflicts(folder);
            const scope = folder ? ` in ${folder.replace(/\/+$/, "")}/` : "";
            const unreadableLine = unreadable ? `\n${unreadable} conflicted document${unreadable === 1 ? "" : "s"} could not be read (path not decryptable) and ${unreadable === 1 ? "is" : "are"} not listed.` : "";
            if (conflicts.length === 0) return `No conflicted notes${scope}.${unreadableLine}`;
            const lines = conflicts.map((c) =>
                `- [${c.path}](${makeDeepLink(vaultName, c.path)}): ${c.conflicts.length} other live version${c.conflicts.length === 1 ? "" : "s"}, winner ${c.revision}`);
            return [`${conflicts.length} conflicted note${conflicts.length === 1 ? "" : "s"}${scope}:`, ...lines].join("\n") + unreadableLine;
        },
    });

    server.addTool({
        name: "get_conflict",
        description:
            "Show a note's conflicting versions (CouchDB mode): the winner, which read_note shows, and every other live version as a line diff against the winner, each with its revision. " +
            "The 'Leaves:' line is what resolve_conflict expects as expected_leaves. " +
            `Diffs are cut to ${GET_CONFLICT_MAX_DIFF_CHARS} characters in total; pass revision to get one version's full text.`,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
            revision: z.string().optional().describe("Optional: one version's revision from a previous get_conflict; returns that version's full text instead of the diffs."),
        }),
        execute: async ({ path, revision }) => {
            if (!vault.getConflict) return CONFLICTS_NEED_COUCHDB_MESSAGE;
            const detail = await vault.getConflict(path);
            if (!detail) return `Note not found: ${path}`;
            const leaves = [detail.winner, ...detail.others];
            if (revision !== undefined) {
                const leaf = leaves.find((l) => l.revision === revision);
                if (!leaf) return `${path} has no live version ${revision}. Live versions: ${leaves.map((l) => l.revision).join(",")}`;
                if (leaf.content === null) return `Version ${describeLeaf(leaf)}`;
                return `Version ${describeLeaf(leaf)}\n\n---\n\n${leaf.content}`;
            }
            if (detail.others.length === 0) return `No conflict: ${path} has one live version (revision ${detail.winner.revision}).`;
            const out = [
                `Conflict: ${path} has ${leaves.length} live versions.`,
                `Leaves: ${leaves.map((l) => l.revision).join(",")}`,
                `Winner (what read_note shows): ${describeLeaf(detail.winner)}`,
            ];
            const budget = Math.floor(GET_CONFLICT_MAX_DIFF_CHARS / detail.others.length);
            for (const leaf of detail.others) {
                out.push("", `Other version: ${describeLeaf(leaf)}`);
                if (leaf.content === null || detail.winner.content === null) {
                    out.push("No diff: a version's text could not be read.");
                    continue;
                }
                const { lines, omitted } = unifiedDiff(diffLines(detail.winner.content, leaf.content), { maxChars: budget, maxLineChars: GET_CONFLICT_MAX_LINE_CHARS });
                if (lines.length === 0 && omitted === 0) {
                    out.push("Same text as the winner.");
                    continue;
                }
                const body = [`--- ${detail.winner.revision} (winner)`, `+++ ${leaf.revision}`, ...lines].join("\n");
                const fence = fenceFor(body);
                out.push(`${fence}diff`, body, fence);
                if (omitted) out.push(`${omitted} more diff line${omitted === 1 ? "" : "s"} not shown; get_conflict with revision="${leaf.revision}" prints this version in full.`);
            }
            out.push(
                "",
                `To resolve: resolve_conflict with expected_leaves="${leaves.map((l) => l.revision).join(",")}" and either keep="<revision>" (that version's text, unchanged) or content="<merged text>". Every other version is then deleted.`,
                `[Open in Obsidian](${makeDeepLink(vaultName, path)})`,
            );
            return out.join("\n");
        },
    });

    if (!readOnly) server.addTool({
        name: "resolve_conflict",
        description:
            "Settle a note's sync conflict (CouchDB mode): keep one version's text as it is (keep), or write merged text (content); either becomes the note's new revision and every other version is deleted. " +
            "Pass the 'Leaves:' line of get_conflict as expected_leaves: if the versions changed since, nothing is written." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
            expected_leaves: z.string().describe("The comma-separated revisions from the 'Leaves:' line of get_conflict."),
            keep: z.string().optional().describe("The revision of the version to keep unchanged. Give keep or content, not both."),
            content: z.string().optional().describe("Merged full markdown text to write. Give keep or content, not both."),
        }),
        execute: async ({ path, expected_leaves, keep, content }) => {
            const denied = checkWrite(path, "update", writeFolders);
            if (denied) return denied;
            if (!vault.resolveConflict) return CONFLICTS_NEED_COUCHDB_MESSAGE;
            if ((keep === undefined) === (content === undefined)) return "Give exactly one of keep or content. Nothing was written.";
            const expected = expected_leaves.split(",").map((r) => r.trim()).filter(Boolean);
            if (keep !== undefined && !expected.includes(keep)) return `keep must be one of the revisions in expected_leaves (${expected.join(",")}). Nothing was written.`;
            let result;
            try {
                result = await vault.resolveConflict(path, expected, keep !== undefined ? { keep } : { content: content! });
            } catch (err) {
                if (err instanceof NoteNotFoundError) return `Note not found: ${path}`;
                if (err instanceof ConflictChangedError) {
                    return `The versions of ${path} changed since get_conflict: live now ${err.current.join(",") || "(none)"}, not ${err.expected.join(",")}. Nothing was written; call get_conflict again.`;
                }
                if (err instanceof ConflictLeafUnreadableError) return `${err.message}. Nothing was written.`;
                throw err;
            }
            if (result.removed.length === 0 && result.content === null && result.remaining.length === 0) {
                return `No conflict: ${path} has one live version (revision ${result.revision}). Nothing was written.`;
            }
            if (result.content !== null) searchIndex.update(path, result.content, Date.now());
            const lines = [
                `${result.remaining.length ? "Conflict partly resolved" : "Conflict resolved"}: ${path}`,
                `Revision: ${result.revision}`,
                `Removed ${result.removed.length} other version${result.removed.length === 1 ? "" : "s"}${result.removed.length ? `: ${result.removed.join(",")}` : ""}`,
            ];
            if (result.remaining.length) lines.push(`Still live: ${result.remaining.join(",")} (changed while resolving); call get_conflict again.`);
            lines.push(`[Open in Obsidian](${makeDeepLink(vaultName, path)})`);
            return lines.join("\n");
        },
    });
}

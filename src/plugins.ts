/**
 * Plugins: extra tools loaded at startup from PLUGIN_DIR (off unless set).
 *
 * Every `.js` / `.mjs` file directly in the directory is imported, in name
 * order, and its default export is called once with a PluginContext. A plugin
 * adds tools with `ctx.addTool` (same shape as a built-in FastMCP tool) and
 * reaches the vault only through `ctx.vault`, which applies the same checks as
 * the built-in tools: READ_ONLY, WRITE_FOLDERS with its create / update /
 * delete permissions, and the same write calls (so a plugin's writes get the
 * same create-only and edit semantics as write_note and edit_note), and keeps
 * the search index current.
 *
 * State: when OPS_DATABASE is set (CouchDB mode, not READ_ONLY), `ctx.store`
 * is a small revision-checked key/value store shared by every instance on the
 * vault, its keys namespaced by the plugin's file name (see plugin-store.ts).
 * Without OPS_DATABASE `ctx.store` is absent, so a plugin can check for it.
 *
 * Writes and op_id: a tool added with `writes: true` is handled like the
 * built-in write tools: with OPS_DATABASE it takes `op_id` through the same
 * wrapper (records in the same database, keyed by tool name and arguments),
 * and READ_ONLY leaves it out. Tools without it get no `op_id`.
 *
 * Trust: a plugin runs in this process with this process's rights. The
 * context gives it no way around the checks above, but nothing stops a
 * plugin's own code from importing anything it likes; install only plugins
 * you would run as the server itself. Startup fails on a plugin that does not
 * load, does not export a function, throws, or adds a tool whose name is
 * taken, so a broken plugin is never half-loaded.
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { NoteExistsError, NoteNotFoundError, RevisionMismatchError, type NoteInfo, type RevisedNote, type VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { checkWrite, type WriteScope } from "./write-scope.js";
import { chooseWriteMode, editNoteText, NO_REVISIONS_MESSAGE } from "./tools.js";
import { READ_ONLY_MESSAGE } from "./vault-readonly.js";
import { scopedStore, type DocStore, type PluginStore } from "./plugin-store.js";

/** Why a plugin write was refused, for a plugin that reacts to it (e.g. picks another path on "exists"). */
export type PluginWriteErrorCode = "read_only" | "denied" | "exists" | "not_found" | "revision_mismatch" | "unsupported" | "failed";

/** A write a plugin asked for was refused; the message is meant for the agent. */
export class PluginWriteError extends Error {
    constructor(message: string, readonly code: PluginWriteErrorCode = "failed") {
        super(message);
        this.name = "PluginWriteError";
    }
}

export interface PluginVault {
    readNote(path: string): Promise<string | null>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    /** CouchDB mode: the note and its revision, as read_note shows them. Undefined in local mode. */
    readNoteRevision?(path: string): Promise<RevisedNote | null>;
    /**
     * Create or replace a note, as write_note does; `createOnly` never replaces,
     * and `expectedRevision` (CouchDB mode) writes only if the note is still at
     * that revision, as write_note's expected_revision does.
     */
    writeNote(path: string, content: string, options?: { createOnly?: boolean; expectedRevision?: string }): Promise<void>;
    /** Change a note's text as edit_note does; returns the new text. */
    editNote(path: string, apply: (content: string) => string): Promise<string>;
    deleteNote(path: string): Promise<void>;
    /** Never replaces a note at `to`. */
    moveNote(from: string, to: string): Promise<void>;
}

export interface PluginTool {
    name: string;
    description: string;
    /**
     * The tool writes: it gets the built-in write tools' treatment. With
     * OPS_DATABASE it takes `op_id` (a retry with the same id returns the first
     * answer without running again), and READ_ONLY leaves it out. Needs a
     * `z.object` for parameters, and must not declare `op_id` itself.
     */
    writes?: boolean;
    parameters: z.ZodType;
    execute: (args: any, ctx: any) => Promise<unknown>;
}

export interface PluginContext {
    vaultName: string;
    readOnly: boolean;
    /** The zod the server uses, for tool parameters. */
    z: typeof z;
    vault: PluginVault;
    /** Present only when OPS_DATABASE is set; see plugin-store.ts. */
    store?: PluginStore;
    addTool(tool: PluginTool): void;
    log(message: string): void;
}

export type Plugin = (ctx: PluginContext) => void | Promise<void>;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

interface ToolServer {
    addTool(tool: any): void;
}

/** Record every tool name registered from now on, so plugins can't shadow one. */
export function trackToolNames(server: ToolServer): Set<string> {
    const names = new Set<string>();
    const add = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        names.add(tool.name);
        return add(tool);
    };
    return names;
}

/** The vault as a plugin sees it: every write passes the same checks as the built-in tools. */
export function guardedVault(vault: VaultBackend, searchIndex: SearchIndex, writeFolders: WriteScope, readOnly: boolean): PluginVault {
    const deny = (message: string | null) => {
        if (message) throw new PluginWriteError(message, "denied");
    };
    const writable = () => {
        if (readOnly) throw new PluginWriteError(READ_ONLY_MESSAGE, "read_only");
    };
    return {
        readNote: (path) => vault.readNote(path),
        getMetadata: (path) => vault.getMetadata(path),
        listNotes: (folder) => vault.listNotes(folder),
        ...(vault.readNoteRevision ? { readNoteRevision: (path: string) => vault.readNoteRevision!(path) } : {}),
        async writeNote(path, content, { createOnly = false, expectedRevision } = {}) {
            writable();
            if (expectedRevision !== undefined) {
                if (createOnly) throw new PluginWriteError("expectedRevision names an existing note, so it can't be combined with createOnly.", "unsupported");
                deny(checkWrite(path, "update", writeFolders));
                if (!vault.updateNote) throw new PluginWriteError(NO_REVISIONS_MESSAGE, "unsupported");
                try {
                    await vault.updateNote(path, () => content, { expectedRevision });
                } catch (err) {
                    if (err instanceof RevisionMismatchError) throw new PluginWriteError(err.message, "revision_mismatch");
                    if (err instanceof NoteNotFoundError) throw new PluginWriteError(`Note not found: ${path}`, "not_found");
                    throw err;
                }
                searchIndex.update(path, content, Date.now());
                return;
            }
            const choice = createOnly ? { mode: "create" as const } : chooseWriteMode(path, writeFolders);
            if ("denied" in choice) throw new PluginWriteError(choice.denied, "denied");
            if (createOnly) deny(checkWrite(path, "create", writeFolders));
            try {
                if (!(await vault.writeNote(path, content, { mode: choice.mode }))) throw new PluginWriteError(`Failed to write note: ${path}`);
            } catch (err) {
                if (err instanceof NoteExistsError) throw new PluginWriteError(`Note already exists: ${path}`, "exists");
                if (err instanceof NoteNotFoundError) {
                    const denied = checkWrite(path, "create", writeFolders);
                    throw new PluginWriteError(denied ?? `Note not found: ${path}`, denied ? "denied" : "not_found");
                }
                throw err;
            }
            searchIndex.update(path, content, Date.now());
        },
        async editNote(path, apply) {
            writable();
            deny(checkWrite(path, "update", writeFolders));
            const updated = await editNoteText(vault, path, apply);
            if (updated === null) throw new PluginWriteError(`Note not found: ${path}`, "not_found");
            searchIndex.update(path, updated, Date.now());
            return updated;
        },
        async deleteNote(path) {
            writable();
            deny(checkWrite(path, "delete", writeFolders));
            if ((await vault.readNote(path)) === null) throw new PluginWriteError(`Note not found: ${path}`, "not_found");
            if (!(await vault.deleteNote(path))) throw new PluginWriteError(`Failed to delete: ${path}`);
            searchIndex.remove(path);
        },
        async moveNote(from, to) {
            writable();
            deny(checkWrite(from, "delete", writeFolders) ?? checkWrite(to, "create", writeFolders));
            const content = await vault.readNote(from);
            try {
                if (!(await vault.moveNote(from, to))) throw new PluginWriteError(`Failed to move: ${from} → ${to}`);
            } catch (err) {
                if (err instanceof NoteExistsError) throw new PluginWriteError(`A note already exists at ${to}.`, "exists");
                throw err;
            }
            searchIndex.remove(from);
            if (content !== null) searchIndex.update(to, content, Date.now());
        },
    };
}

export interface LoadOptions {
    server: ToolServer;
    toolNames: Set<string>;
    vault: VaultBackend;
    searchIndex: SearchIndex;
    vaultName: string;
    readOnly: boolean;
    writeFolders: WriteScope;
    /** OPS_DATABASE's documents; each plugin gets its own namespaced `ctx.store` on it. Absent: no `ctx.store`. */
    store?: DocStore;
}

/** Load every plugin in `dir`. Throws, naming the file, on the first one that fails. Returns the files loaded. */
export async function loadPlugins(dir: string, options: LoadOptions): Promise<string[]> {
    const root = resolve(dir);
    // A symlink counts when it points at a file: a Kubernetes ConfigMap volume
    // presents every key as a symlink. A link to nothing stops startup like a
    // plugin that fails to load.
    const files: string[] = [];
    for (const e of await readdir(root, { withFileTypes: true })) {
        if (!/\.(m?js)$/.test(e.name)) continue;
        if (e.isFile()) files.push(e.name);
        else if (e.isSymbolicLink()) {
            const target = await stat(join(root, e.name)).catch(() => null);
            if (!target) throw new Error(`plugin ${e.name} is a symlink to nothing.`);
            if (target.isFile()) files.push(e.name);
        }
    }
    files.sort();
    const vault = guardedVault(options.vault, options.searchIndex, options.writeFolders, options.readOnly);
    for (const file of files) {
        const where = `plugin ${file}`;
        let plugin: unknown;
        try {
            plugin = (await import(pathToFileURL(join(root, file)).href)).default;
        } catch (err) {
            throw new Error(`${where} failed to load: ${(err as Error).message}`);
        }
        if (typeof plugin !== "function") throw new Error(`${where} has no default export function.`);
        const ctx: PluginContext = {
            vaultName: options.vaultName,
            readOnly: options.readOnly,
            z,
            vault,
            ...(options.store ? { store: scopedStore(options.store, file) } : {}),
            log: (message) => console.log(`[${file}] ${message}`),
            addTool: (tool) => {
                if (!tool || typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
                    throw new Error(`${where}: tool name must match ${TOOL_NAME}, got ${JSON.stringify(tool?.name)}.`);
                }
                if (options.toolNames.has(tool.name)) throw new Error(`${where}: a tool named ${tool.name} already exists.`);
                if (typeof tool.execute !== "function" || !tool.parameters) throw new Error(`${where}: tool ${tool.name} needs parameters and execute.`);
                if (tool.writes !== undefined && typeof tool.writes !== "boolean") throw new Error(`${where}: tool ${tool.name}: writes must be true or false.`);
                if (tool.writes) {
                    const shape = (tool.parameters as { shape?: Record<string, unknown> }).shape;
                    if (!shape || typeof (tool.parameters as { extend?: unknown }).extend !== "function") throw new Error(`${where}: tool ${tool.name} has writes: true, so its parameters must be a z.object.`);
                    if ("op_id" in shape) throw new Error(`${where}: tool ${tool.name} has writes: true, so op_id is added by the server; don't declare it.`);
                    if (options.readOnly) {
                        console.log(`[${file}] READ_ONLY: write tool ${tool.name} not registered.`);
                        return;
                    }
                }
                const execute = tool.execute;
                options.server.addTool({
                    ...tool,
                    // A refused write is an answer for the agent, not a server error.
                    execute: async (args: unknown, c: unknown) => {
                        try {
                            return await execute(args, c);
                        } catch (err) {
                            if (err instanceof PluginWriteError) return err.message;
                            throw err;
                        }
                    },
                });
            },
        };
        try {
            await (plugin as Plugin)(ctx);
        } catch (err) {
            throw new Error(`${where} failed during setup: ${(err as Error).message}`);
        }
    }
    return files;
}

/**
 * `ctx.store`: a small revision-checked key/value store for plugins.
 *
 * A plugin that needs state shared by every server instance on the vault (a
 * counter, a last-run marker) can't keep it in memory or on local disk, and
 * shouldn't keep it in a note: notes replicate to every device. The store
 * keeps one JSON value per key in OPS_DATABASE, the database that already
 * holds the op_id records, which LiveSync never replicates.
 *
 * Every write names the revision it read (`null` for "the key must not exist
 * yet"); CouchDB refuses the write with a 409 when the document has moved on,
 * and the plugin gets the current value back to decide again. That is the
 * whole concurrency model: there is no lock and no transaction across keys.
 *
 * Keys are namespaced by the plugin's file name, so two plugins can't read or
 * overwrite each other's keys, and kept apart from op_id records by the
 * `plugin:` id prefix (op records use `op:`).
 *
 * Kept free of livesync-commonlib imports so it is unit-testable in isolation.
 */
import { databaseUrl } from "./couchdb-preflight.js";

export const STORE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A stored value's JSON may not be larger than this. */
export const STORE_MAX_VALUE_BYTES = 64 * 1024;

export interface StoredValue {
    value: unknown;
    /** Opaque; pass it back to `put` to replace this value. */
    revision: string;
}

export type PutResult =
    | { revision: string }
    /** Not written: the key was not at the expected revision. `current` is what is there now (null: nothing). */
    | { conflict: true; current: StoredValue | null };

/** What a plugin sees as `ctx.store`. */
export interface PluginStore {
    get(key: string): Promise<StoredValue | null>;
    /** `expectedRevision` null: write only if the key has no value yet. */
    put(key: string, value: unknown, expectedRevision: string | null): Promise<PutResult>;
}

/** The documents behind every plugin's store, addressed by full id. */
export interface DocStore {
    getDoc(id: string): Promise<StoredValue | null>;
    /** false: refused because the document is not at `expectedRevision` (CouchDB 409). */
    putDoc(id: string, value: unknown, expectedRevision: string | null): Promise<string | false>;
}

/** Document id for a plugin's key. The file name is percent-encoded and keys have no `:`, so ids never collide. */
export function storeDocId(pluginFile: string, key: string): string {
    return `plugin:${encodeURIComponent(pluginFile)}:${key}`;
}

/** `ctx.store` for one plugin file: validates arguments and namespaces its keys. */
export function scopedStore(docs: DocStore, pluginFile: string): PluginStore {
    const idFor = (key: string) => {
        if (typeof key !== "string" || !STORE_KEY_PATTERN.test(key)) {
            throw new TypeError(`store key must match ${STORE_KEY_PATTERN}, got ${JSON.stringify(key)}`);
        }
        return storeDocId(pluginFile, key);
    };
    return {
        get: async (key) => docs.getDoc(idFor(key)),
        async put(key, value, expectedRevision) {
            const id = idFor(key);
            if (expectedRevision !== null && (typeof expectedRevision !== "string" || expectedRevision === "")) {
                throw new TypeError("expectedRevision must be a revision from get, or null to create the key");
            }
            const json = JSON.stringify(value);
            if (json === undefined) throw new TypeError("store value must be JSON-serialisable");
            if (Buffer.byteLength(json) > STORE_MAX_VALUE_BYTES) throw new RangeError(`store value is larger than ${STORE_MAX_VALUE_BYTES} bytes as JSON`);
            const revision = await docs.putDoc(id, JSON.parse(json), expectedRevision);
            if (revision) return { revision };
            return { conflict: true, current: await docs.getDoc(id) };
        },
    };
}

interface ValueDoc {
    _id: string;
    _rev?: string;
    value: unknown;
}

/** Values in a CouchDB database of their own (OPS_DATABASE), one document per key. */
export class CouchDocStore implements DocStore {
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(url: string, readonly database: string, username: string, password: string, private readonly fetchImpl: typeof fetch = fetch) {
        this.base = databaseUrl(url, database).replace(/\/+$/, "");
        this.headers = {
            "Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
            "Content-Type": "application/json",
        };
    }

    async getDoc(id: string): Promise<StoredValue | null> {
        const resp = await this.fetchImpl(`${this.base}/${encodeURIComponent(id)}`, { headers: this.headers });
        if (resp.status === 404) return null;
        if (!resp.ok) throw new Error(`plugin store read failed: ${resp.status} ${resp.statusText}`);
        const doc = (await resp.json()) as ValueDoc;
        return { value: doc.value, revision: doc._rev! };
    }

    async putDoc(id: string, value: unknown, expectedRevision: string | null): Promise<string | false> {
        // CouchDB can accept a PUT with a _rev for a document that doesn't
        // exist: measured on 3.5.3, the revision of an empty deletion
        // (1-967a00dff5e02add41819138abb3284d) creates it at generation 2,
        // where any other revision answers 409. So a revision for a missing
        // key is refused here, before the PUT. The store never deletes,
        // so a key that is missing now can only appear by a create, and a PUT
        // with a revision that isn't that document's answers 409.
        if (expectedRevision !== null && (await this.getDoc(id)) === null) return false;
        const doc: ValueDoc = { _id: id, ...(expectedRevision !== null ? { _rev: expectedRevision } : {}), value };
        const resp = await this.fetchImpl(`${this.base}/${encodeURIComponent(id)}`, { method: "PUT", headers: this.headers, body: JSON.stringify(doc) });
        // 409 is the only "refused because it changed"; anything else is a failure, never a conflict.
        if (resp.status === 409) return false;
        if (!resp.ok) throw new Error(`plugin store write failed: ${resp.status} ${resp.statusText}`);
        return ((await resp.json()) as { rev: string }).rev;
    }
}

/** In-memory documents with CouchDB's revision rule, for tests. */
export class MemoryDocStore implements DocStore {
    readonly docs = new Map<string, { value: unknown; revision: string }>();
    private revs = 0;

    async getDoc(id: string): Promise<StoredValue | null> {
        const doc = this.docs.get(id);
        return doc ? { value: structuredClone(doc.value), revision: doc.revision } : null;
    }

    async putDoc(id: string, value: unknown, expectedRevision: string | null): Promise<string | false> {
        const current = this.docs.get(id);
        if ((current?.revision ?? null) !== expectedRevision) return false;
        const revision = `${++this.revs}-mem`;
        this.docs.set(id, { value: structuredClone(value), revision });
        return revision;
    }
}

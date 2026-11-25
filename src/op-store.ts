/**
 * Idempotency records for write tools (`op_id`).
 *
 * An agent that times out and retries a write must not apply it twice: a
 * retried `edit_note` append would add the same line again. A write tool
 * called with an `op_id` first claims that id here; the first claim runs the
 * call and stores its answer, and any later call with the same id gets the
 * stored answer instead of running again.
 *
 * Records live in their own CouchDB database (OPS_DATABASE), never in the
 * vault database, so LiveSync never replicates them to a device, and every
 * server instance on the vault sees them, across restarts. The claim is a
 * put without a revision, which CouchDB refuses (409) when the record exists,
 * so two instances can't both claim one id. `_local` documents can't be used:
 * CouchDB writes them without any revision check.
 *
 * Kept free of livesync-commonlib imports so it is unit-testable in isolation.
 */
import { createHash } from "node:crypto";
import { databaseUrl } from "./couchdb-preflight.js";

/** A record older than this no longer counts: its id can be used again. */
export const OP_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const OP_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type Claim =
    /** First use: run the call, then `complete` with its answer. */
    | { state: "new"; token: string }
    /** Already done: this is the answer it gave. */
    | { state: "done"; result: string }
    /** Claimed but never completed: still running, or interrupted. Its outcome is unknown. */
    | { state: "pending"; startedAt: number }
    /** The id was used for a different call. */
    | { state: "mismatch" };

export interface OpStore {
    claim(opId: string, fingerprint: string, now?: number): Promise<Claim>;
    complete(opId: string, token: string, result: string, now?: number): Promise<void>;
}

/** Identifies a call: the tool and its arguments without the op_id, keys sorted. */
export function fingerprint(tool: string, args: Record<string, unknown>): string {
    const { op_id: _ignored, ...rest } = args;
    const sorted = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    return createHash("sha256").update(JSON.stringify([tool, sorted])).digest("hex");
}

interface OpRecord {
    _id: string;
    _rev?: string;
    fingerprint: string;
    state: "pending" | "done";
    startedAt: number;
    finishedAt?: number;
    result?: string;
}

function recordId(opId: string): string {
    // Hashed so any allowed id maps to a plain document id.
    return "op:" + createHash("sha256").update(opId).digest("hex");
}

function judge(record: OpRecord, fp: string): Claim {
    if (record.fingerprint !== fp) return { state: "mismatch" };
    if (record.state === "done") return { state: "done", result: record.result ?? "" };
    return { state: "pending", startedAt: record.startedAt };
}

/** Records in a CouchDB database of their own. */
export class CouchOpStore implements OpStore {
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(url: string, readonly database: string, username: string, password: string, private readonly fetchImpl: typeof fetch = fetch) {
        this.base = databaseUrl(url, database).replace(/\/+$/, "");
        this.headers = {
            "Authorization": "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
            "Content-Type": "application/json",
        };
    }

    /** Create the database when it is missing. Throws with a readable reason when it can't. */
    async ensureDatabase(): Promise<"exists" | "created"> {
        const head = await this.fetchImpl(this.base, { method: "GET", headers: this.headers });
        if (head.ok) return "exists";
        if (head.status !== 404) throw new Error(`OPS_DATABASE ${this.database}: CouchDB answered ${head.status} ${head.statusText}`);
        const put = await this.fetchImpl(this.base, { method: "PUT", headers: this.headers });
        // 412: another instance created it in the meantime.
        if (put.ok || put.status === 412) return "created";
        throw new Error(
            `OPS_DATABASE ${this.database} does not exist and could not be created (${put.status} ${put.statusText}). ` +
            "Create it once as a CouchDB admin and give the server's user access to it.",
        );
    }

    private async get(id: string): Promise<OpRecord | null> {
        const resp = await this.fetchImpl(`${this.base}/${encodeURIComponent(id)}`, { headers: this.headers });
        if (resp.status === 404) return null;
        if (!resp.ok) throw new Error(`op record read failed: ${resp.status}`);
        return (await resp.json()) as OpRecord;
    }

    /** Store a record; false when CouchDB refuses it because the record changed (409). */
    private async put(record: OpRecord): Promise<string | false> {
        const resp = await this.fetchImpl(`${this.base}/${encodeURIComponent(record._id)}`, { method: "PUT", headers: this.headers, body: JSON.stringify(record) });
        if (resp.status === 409) return false;
        if (!resp.ok) throw new Error(`op record write failed: ${resp.status}`);
        return ((await resp.json()) as { rev: string }).rev;
    }

    async claim(opId: string, fp: string, now = Date.now()): Promise<Claim> {
        const id = recordId(opId);
        for (let attempt = 0; attempt < 3; attempt++) {
            const existing = await this.get(id);
            // An expired record is replaced as a child of its revision, so two
            // instances can't both take it over either.
            if (existing && now - existing.startedAt < OP_RECORD_TTL_MS) return judge(existing, fp);
            const rev = await this.put({ _id: id, ...(existing ? { _rev: existing._rev } : {}), fingerprint: fp, state: "pending", startedAt: now });
            if (rev) return { state: "new", token: rev };
            // Someone else claimed it between the read and the write: read theirs.
        }
        throw new Error(`could not claim op_id ${opId}`);
    }

    async complete(opId: string, token: string, result: string, now = Date.now()): Promise<void> {
        const id = recordId(opId);
        const existing = await this.get(id);
        if (!existing || existing._rev !== token) throw new Error(`op record for ${opId} changed while the call ran`);
        const rev = await this.put({ ...existing, state: "done", finishedAt: now, result });
        if (!rev) throw new Error(`op record for ${opId} changed while the call ran`);
    }
}

/** In-memory records, for tests. */
export class MemoryOpStore implements OpStore {
    readonly records = new Map<string, OpRecord & { _rev: string }>();
    private revs = 0;

    async claim(opId: string, fp: string, now = Date.now()): Promise<Claim> {
        const existing = this.records.get(opId);
        if (existing && now - existing.startedAt < OP_RECORD_TTL_MS) return judge(existing, fp);
        const rev = `${++this.revs}`;
        this.records.set(opId, { _id: opId, _rev: rev, fingerprint: fp, state: "pending", startedAt: now });
        return { state: "new", token: rev };
    }

    async complete(opId: string, token: string, result: string, now = Date.now()): Promise<void> {
        const existing = this.records.get(opId);
        if (!existing || existing._rev !== token) throw new Error(`op record for ${opId} changed while the call ran`);
        this.records.set(opId, { ...existing, _rev: `${++this.revs}`, state: "done", finishedAt: now, result });
    }
}

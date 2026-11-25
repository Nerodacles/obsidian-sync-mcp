import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CouchOpStore, MemoryOpStore, OP_RECORD_TTL_MS, fingerprint } from "./op-store.js";

describe("fingerprint", () => {
    it("ignores op_id, undefined values and key order", () => {
        assert.equal(fingerprint("edit_note", { path: "a.md", content: "x", op_id: "1" }), fingerprint("edit_note", { content: "x", path: "a.md", operation: undefined }));
    });
    it("differs by tool and by arguments", () => {
        assert.notEqual(fingerprint("edit_note", { path: "a.md" }), fingerprint("write_note", { path: "a.md" }));
        assert.notEqual(fingerprint("edit_note", { path: "a.md", content: "x" }), fingerprint("edit_note", { path: "a.md", content: "y" }));
    });
});

describe("MemoryOpStore", () => {
    it("new, then pending until completed, then done with the stored answer", async () => {
        const s = new MemoryOpStore();
        const c = await s.claim("op", "fp", 1000);
        assert.equal(c.state, "new");
        assert.deepEqual(await s.claim("op", "fp", 1001), { state: "pending", startedAt: 1000 });
        await s.complete("op", (c as any).token, "answer", 1002);
        assert.deepEqual(await s.claim("op", "fp", 1003), { state: "done", result: "answer" });
        assert.deepEqual(await s.claim("op", "other", 1003), { state: "mismatch" });
    });
    it("an expired record can be claimed again", async () => {
        const s = new MemoryOpStore();
        await s.claim("op", "fp", 0);
        assert.equal((await s.claim("op", "fp", OP_RECORD_TTL_MS)).state, "new");
    });
});

/** A tiny CouchDB: documents with revisions, 409 on a stale or missing revision. */
function fakeCouch() {
    const docs = new Map<string, any>();
    let dbExists = false;
    let canCreate = true;
    let rev = 0;
    const fetchImpl = (async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        const method = init.method ?? "GET";
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (path.length === 1) {
            if (method === "GET") return json(dbExists ? 200 : 404, {});
            if (!canCreate) return json(401, {});
            dbExists = true;
            return json(201, { ok: true });
        }
        const id = decodeURIComponent(path[1]);
        const cur = docs.get(id);
        if (method === "GET") return cur ? json(200, cur) : json(404, {});
        const body = JSON.parse(init.body);
        if ((cur?._rev) !== body._rev) return json(409, { error: "conflict" });
        const next = { ...body, _rev: `${++rev}-x` };
        docs.set(id, next);
        return json(201, { ok: true, rev: next._rev });
    }) as unknown as typeof fetch;
    return { fetchImpl, docs, setCanCreate: (v: boolean) => { canCreate = v; }, setExists: (v: boolean) => { dbExists = v; } };
}

describe("CouchOpStore", () => {
    it("creates a missing database, or reports why it can't", async () => {
        const couch = fakeCouch();
        assert.equal(await new CouchOpStore("http://c:5984", "ops", "u", "p", couch.fetchImpl).ensureDatabase(), "created");
        assert.equal(await new CouchOpStore("http://c:5984", "ops", "u", "p", couch.fetchImpl).ensureDatabase(), "exists");
        const denied = fakeCouch();
        denied.setCanCreate(false);
        await assert.rejects(new CouchOpStore("http://c:5984", "ops", "u", "p", denied.fetchImpl).ensureDatabase(), /could not be created \(401/);
    });

    it("two stores on one database: only one claim of an id wins", async () => {
        const couch = fakeCouch();
        const a = new CouchOpStore("http://c:5984", "ops", "u", "p", couch.fetchImpl);
        const b = new CouchOpStore("http://c:5984", "ops", "u", "p", couch.fetchImpl);
        const claims = await Promise.all([a.claim("op-1", "fp"), b.claim("op-1", "fp")]);
        assert.deepEqual(claims.map((c) => c.state).sort(), ["new", "pending"]);
        const winner = claims.find((c) => c.state === "new") as any;
        await (claims[0].state === "new" ? a : b).complete("op-1", winner.token, "done!");
        assert.deepEqual(await b.claim("op-1", "fp"), { state: "done", result: "done!" });
        assert.deepEqual(await a.claim("op-1", "fp"), { state: "done", result: "done!" });
        assert.deepEqual(await a.claim("op-1", "other"), { state: "mismatch" });
        // The stored id is a hash, never the caller's text.
        assert.ok([...couch.docs.keys()].every((k) => /^op:[0-9a-f]{64}$/.test(k)));
    });

    it("complete refuses when the record changed under the call", async () => {
        const couch = fakeCouch();
        const a = new CouchOpStore("http://c:5984", "ops", "u", "p", couch.fetchImpl);
        const c = await a.claim("op", "fp", 0) as any;
        await a.claim("op", "fp", OP_RECORD_TTL_MS); // expired and taken over
        await assert.rejects(a.complete("op", c.token, "late"), /changed while the call ran/);
    });
});

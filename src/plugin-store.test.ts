import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CouchDocStore, MemoryDocStore, scopedStore, storeDocId, STORE_MAX_VALUE_BYTES } from "./plugin-store.js";

describe("plugin store", () => {
    it("create-only, then revision-checked replace", async () => {
        const store = scopedStore(new MemoryDocStore(), "counter.mjs");
        assert.equal(await store.get("n"), null);
        const first = await store.put("n", 1, null);
        assert.ok("revision" in first);
        // A second create is refused and hands back what is there.
        assert.deepEqual(await store.put("n", 99, null), { conflict: true, current: { value: 1, revision: first.revision } });
        const second = await store.put("n", 2, first.revision);
        assert.ok("revision" in second);
        // The old revision is stale now.
        const stale = await store.put("n", 3, first.revision);
        assert.deepEqual(stale, { conflict: true, current: { value: 2, revision: second.revision } });
        assert.deepEqual(await store.get("n"), { value: 2, revision: second.revision });
    });

    it("a revision for a key that has no value is a conflict with current null", async () => {
        const store = scopedStore(new MemoryDocStore(), "a.mjs");
        assert.deepEqual(await store.put("missing", 1, "1-abc"), { conflict: true, current: null });
    });

    it("keys are namespaced per plugin file and apart from op records", async () => {
        const docs = new MemoryDocStore();
        const a = scopedStore(docs, "a.mjs");
        const b = scopedStore(docs, "b.mjs");
        await a.put("counter", 5, null);
        assert.equal(await b.get("counter"), null);
        assert.ok("revision" in (await b.put("counter", 7, null)));
        assert.equal((await a.get("counter"))!.value, 5);
        assert.deepEqual([...docs.docs.keys()].sort(), ["plugin:a.mjs:counter", "plugin:b.mjs:counter"]);
        // A file name with ":" can't forge another plugin's id: keys have no ":" and the name is encoded.
        assert.notEqual(storeDocId("a.mjs:x", "y"), storeDocId("a.mjs", "x:y"));
        assert.equal(storeDocId("a.mjs:x", "y"), "plugin:a.mjs%3Ax:y");
    });

    it("refuses bad keys, bad revisions and values that aren't JSON or are too large", async () => {
        const store = scopedStore(new MemoryDocStore(), "a.mjs");
        for (const key of ["", "a:b", "a/b", "x".repeat(129), 5 as unknown as string]) {
            await assert.rejects(store.put(key, 1, null), /store key must match/, String(key));
            await assert.rejects(store.get(key), /store key must match/, String(key));
        }
        await assert.rejects(store.put("k", 1, ""), /expectedRevision must be/);
        await assert.rejects(store.put("k", undefined, null), /JSON-serialisable/);
        await assert.rejects(store.put("k", "x".repeat(STORE_MAX_VALUE_BYTES), null), /larger than/);
        assert.equal(await store.get("k"), null, "nothing was written");
    });

    it("values round-trip as JSON (no shared references, Dates become strings)", async () => {
        const store = scopedStore(new MemoryDocStore(), "a.mjs");
        const value = { list: [1, "two", true], at: new Date(0) };
        await store.put("v", value, null);
        value.list.push(4);
        assert.deepEqual((await store.get("v"))!.value, { list: [1, "two", true], at: "1970-01-01T00:00:00.000Z" });
    });
});

describe("CouchDocStore", () => {
    function stub(responses: Array<{ status: number; body?: unknown }>) {
        const calls: Array<{ url: string; method: string; body?: any }> = [];
        const fetchImpl = (async (url: string, init: RequestInit = {}) => {
            calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
            const r = responses.shift()!;
            return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, statusText: String(r.status) });
        }) as unknown as typeof fetch;
        return { calls, store: new CouchDocStore("http://couch:5984", "ops", "u", "p", fetchImpl) };
    }

    it("creates without _rev, replaces with _rev, maps 409 to a refusal", async () => {
        const { calls, store } = stub([{ status: 201, body: { rev: "1-a" } }, { status: 409, body: { error: "conflict" } }, { status: 200, body: { _id: "plugin:x.mjs:k", _rev: "1-a", value: { n: 1 } } }, { status: 201, body: { rev: "2-b" } }]);
        assert.equal(await store.putDoc("plugin:x.mjs:k", { n: 1 }, null), "1-a");
        assert.equal(await store.putDoc("plugin:x.mjs:k", { n: 1 }, null), false);
        assert.equal(await store.putDoc("plugin:x.mjs:k", { n: 2 }, "1-a"), "2-b");
        assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
            ["PUT", "http://couch:5984/ops/plugin%3Ax.mjs%3Ak", { _id: "plugin:x.mjs:k", value: { n: 1 } }],
            ["PUT", "http://couch:5984/ops/plugin%3Ax.mjs%3Ak", { _id: "plugin:x.mjs:k", value: { n: 1 } }],
            ["GET", "http://couch:5984/ops/plugin%3Ax.mjs%3Ak", undefined],
            ["PUT", "http://couch:5984/ops/plugin%3Ax.mjs%3Ak", { _id: "plugin:x.mjs:k", _rev: "1-a", value: { n: 2 } }],
        ]);
    });

    it("a revision for a missing document is refused without a PUT (CouchDB would create it)", async () => {
        const { calls, store } = stub([{ status: 404, body: { error: "not_found" } }]);
        assert.equal(await store.putDoc("plugin:x.mjs:k", 1, "1-a"), false);
        assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    });

    it("reads value and revision; 404 is null; any other failure throws, never a conflict", async () => {
        const { store } = stub([{ status: 200, body: { _id: "i", _rev: "3-c", value: [1] } }, { status: 404, body: {} }, { status: 500 }, { status: 401 }, { status: 200, body: { _id: "i", _rev: "1-a", value: 1 } }, { status: 503 }]);
        assert.deepEqual(await store.getDoc("i"), { value: [1], revision: "3-c" });
        assert.equal(await store.getDoc("i"), null);
        await assert.rejects(store.getDoc("i"), /plugin store read failed: 500/);
        await assert.rejects(store.putDoc("i", 1, null), /plugin store write failed: 401/);
        await assert.rejects(store.putDoc("i", 1, "1-a"), /plugin store write failed: 503/);
    });
});

/**
 * Plugin store and the example new_item plugin against a real CouchDB:
 * revision-checked ctx.store, then 20 concurrent new_item calls across two
 * server instances.
 *
 * Destructive: drops and recreates its own test databases. Never point it at
 * a real vault.
 *
 * Run: npm run test:new-item   (builds first, then expects CouchDB on localhost:5992)
 *
 *   docker run -d --name couchdb-newitem -p 127.0.0.1:5992:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3.5.3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * NEW_ITEM_PLUGIN loads another plugin file instead of examples/new-item.mjs
 * (to show the run fails on a broken variant). Each scenario prints PASS or
 * FAIL; the run exits 1 on any FAIL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CouchDocStore, scopedStore } from "../src/plugin-store.js";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5992").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const PLUGIN = resolve(process.env.NEW_ITEM_PLUGIN ?? "examples/new-item.mjs");
const DB = "newitemvault";
const OPS_DB = "newitemops";
const AUTH = "new-item-test-token";
const CALLS = 20;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

type Call = (name: string, args: Record<string, unknown>) => Promise<string>;

async function connect(port: number): Promise<Call> {
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${AUTH}` };
    const init = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "new-item", version: "1.0" } } }) });
    if (!init.ok) throw new Error(`initialize: ${init.status}`);
    const session = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    return async (name, args) => {
        const resp = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const text = parseSSE(await resp.text())?.result?.content?.[0]?.text;
        if (typeof text !== "string") throw new Error(`${name}: no text`);
        return text;
    };
}

interface Server { proc: ChildProcess; logs: string; dirs: string[]; port: number }

async function startServer(port: number, env: Record<string, string>, withPlugin: boolean): Promise<Server> {
    const dataDir = await mkdtemp(join(tmpdir(), "new-item-e2e-"));
    const dirs = [dataDir];
    const extra: Record<string, string> = {};
    if (withPlugin) {
        const pluginDir = await mkdtemp(join(tmpdir(), "new-item-plugins-"));
        await copyFile(PLUGIN, join(pluginDir, "new-item.mjs"));
        dirs.push(pluginDir);
        extra.PLUGIN_DIR = pluginDir;
    }
    const server: Server = {
        proc: spawn("node", ["dist/main.js"], {
            env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_AUTH_TOKEN: AUTH, COUCHDB_URL: COUCH, COUCHDB_USER: COUCH_USER, COUCHDB_PASSWORD: COUCH_PASSWORD, COUCHDB_DATABASE: DB, VAULT_NAME: "Item Vault", DATA_DIR: dataDir, OPS_DATABASE: OPS_DB, ...extra, ...env },
            stdio: "pipe",
        }),
        logs: "",
        dirs,
        port,
    };
    server.proc.stdout?.on("data", (d) => { server.logs += d.toString(); });
    server.proc.stderr?.on("data", (d) => { server.logs += d.toString(); });
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (server.proc.exitCode !== null) throw new Error(`server on ${port} exited:\n${server.logs}`);
        try { await connect(port); return server; } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server on ${port} did not start:\n${server.logs}`);
}

async function stopServer(server: Server): Promise<void> {
    server.proc.kill("SIGTERM");
    await new Promise((r) => server.proc.once("exit", r));
    for (const d of server.dirs) await rm(d, { recursive: true, force: true });
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}

for (const db of [DB, OPS_DB]) await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: couchAuth });
for (const db of [DB, OPS_DB]) {
    const created = await fetch(`${COUCH}/${db}`, { method: "PUT", headers: couchAuth });
    if (!created.ok) throw new Error(`could not create ${db}: ${created.status}`);
}

// --- ctx.store's CouchDB semantics, measured directly ---
{
    const docs = new CouchDocStore(COUCH, OPS_DB, COUCH_USER, COUCH_PASSWORD);
    const store = scopedStore(docs, "probe.mjs");
    const first = await store.put("k", { n: 1 }, null);
    const again = await store.put("k", { n: 2 }, null);
    check("store-create-only", "revision" in first && "conflict" in again && JSON.stringify(again.current?.value) === '{"n":1}',
        `create ${JSON.stringify(first)}; second create ${JSON.stringify(again)}`);
    const rev = "revision" in first ? first.revision : "";
    const next = await store.put("k", { n: 2 }, rev);
    const stale = await store.put("k", { n: 3 }, rev);
    check("store-stale-revision", "revision" in next && "conflict" in stale && JSON.stringify(stale.current?.value) === '{"n":2}',
        `with current revision ${JSON.stringify(next)}; with the old one ${JSON.stringify(stale)}`);
    // The first revision is the one CouchDB itself accepts on a missing document (see the MEASURED line).
    const ghosts = [await store.put("never-created", 1, "1-967a00dff5e02add41819138abb3284d"), await store.put("never-created", 1, "1-0123456789abcdef0123456789abcdef")];
    check("store-revision-on-missing", ghosts.every((g) => "conflict" in g && g.current === null) && (await store.get("never-created")) === null,
        `revision on a key with no value: ${JSON.stringify(ghosts)}`);
    for (const rev of ["1-967a00dff5e02add41819138abb3284d", "1-0123456789abcdef0123456789abcdef"]) {
        const bare = await fetch(`${COUCH}/${OPS_DB}/raw-probe-${rev.slice(2, 6)}`, { method: "PUT", headers: { ...couchAuth, "Content-Type": "application/json" }, body: JSON.stringify({ _rev: rev, value: 1 }) });
        console.log(`  MEASURED raw CouchDB PUT with _rev ${rev} on a missing document: ${bare.status} ${(await bare.text()).trim()}`);
    }
    const raw = await (await fetch(`${COUCH}/${OPS_DB}/${encodeURIComponent("plugin:probe.mjs:k")}`, { headers: couchAuth })).json() as Record<string, unknown>;
    check("store-doc-shape", raw._id === "plugin:probe.mjs:k" && JSON.stringify(raw.value) === '{"n":2}', `raw document ${JSON.stringify(raw)}`);
    // A user that doesn't exist: CouchDB locks a user out after repeated bad passwords, and this must not lock out the real one.
    const wrong = new CouchDocStore(COUCH, OPS_DB, "no-such-user", "wrong-password");
    let thrown = "";
    try { await scopedStore(wrong, "probe.mjs").put("k", 1, null); } catch (err) { thrown = (err as Error).message; }
    check("store-failure-is-not-conflict", /write failed: 401/.test(thrown), `bad credentials: ${JSON.stringify(thrown)}`);
}

// --- new_item across two instances ---
const scoped = { WRITE_FOLDERS: "ToDo:create+update" };
const a = await startServer(9901, scoped, true);
const b = await startServer(9902, scoped, true);
// An unrestricted instance without the plugin, for setup and inspection only.
const c = await startServer(9903, {}, false);
try {
    check("plugin-loaded", /Plugins from .*new-item\.mjs; ctx\.store in newitemops/.test(a.logs) && /new-item\.mjs; ctx\.store/.test(b.logs),
        (a.logs.match(/Plugins from .*/)?.[0] ?? "no plugin line").replace(/\/tmp\/\S+/, "<tmp>"));
    const onC = await connect(c.port);
    await onC("write_note", { path: "ToDo/items/README.md", content: "Not an item." });

    const started = Date.now();
    const answers = await Promise.all(Array.from({ length: CALLS }, async (_, i) => {
        const call = await connect(i % 2 === 0 ? a.port : b.port);
        const t0 = Date.now();
        const text = await call("new_item", { title: `Concurrent item ${i}`, fields: { caller: i } });
        return { i, text, ms: Date.now() - t0 };
    }));
    const wall = Date.now() - started;
    const ids = answers.map((x) => x.text.match(/^Created (moo-\d+):/)?.[1] ?? null);
    const created = ids.filter((x): x is string => x !== null);
    const numbers = created.map((x) => Number(x.slice(4))).sort((p, q) => p - q);
    const skipped = answers.flatMap((x) => (x.text.match(/^Taken by other callers first: (.*)\.$/m)?.[1] ?? "").split(", ").filter(Boolean));
    for (const x of answers) console.log(`  caller ${String(x.i).padStart(2)} on ${x.i % 2 === 0 ? "A" : "B"} ${String(x.ms).padStart(5)} ms: ${x.text.split("\n").filter((l) => !l.startsWith("[Open")).join(" | ")}`);
    console.log(`  wall ${wall} ms; ${skipped.length} refused create attempts in total`);
    check("all-created", created.length === CALLS, `${created.length}/${CALLS} answers say Created`);
    check("distinct-ids", new Set(created).size === CALLS, `${new Set(created).size} distinct ids: ${numbers.join(",")}`);
    const max = numbers.at(-1) ?? 0;
    const gaps = Array.from({ length: max }, (_, k) => k + 1).filter((n) => !numbers.includes(n));
    check("no-gaps", gaps.length === 0, `highest ${max}; numbers 1..${max} not created: ${gaps.length ? gaps.join(",") : "none"}`);

    const listing = await onC("list_notes", { folder: "ToDo/items" });
    const itemLines = listing.split("\n").filter((l) => /moo-\d+\.md/.test(l));
    check("notes-in-vault", itemLines.length === CALLS, `list_notes shows ${itemLines.length} item notes`);
    // Every note holds its own caller's fields: no create replaced another's note.
    let intact = 0;
    for (const x of answers) {
        const id = x.text.match(/^Created (moo-\d+):/)?.[1];
        if (!id) continue;
        const body = await onC("read_note", { path: `ToDo/items/${id}.md` });
        if (body.includes(`caller: ${x.i}\n`) && body.includes(`# ${id} Concurrent item ${x.i}\n`) && body.includes(`id: ${id}\n`)) intact++;
    }
    check("notes-intact", intact === CALLS, `${intact}/${CALLS} notes carry their caller's title and fields`);

    const counterDoc = await (await fetch(`${COUCH}/${OPS_DB}/${encodeURIComponent("plugin:new-item.mjs:counter")}`, { headers: couchAuth })).json() as { value?: number; _rev?: string };
    check("counter-is-highest", counterDoc.value === max, `counter ${counterDoc.value} (rev ${counterDoc._rev}), highest id ${max}`);

    // A deleted item's number is not handed out again: the counter remembers it.
    const last = `ToDo/items/moo-${String(max).padStart(3, "0")}.md`;
    const del = await onC("delete_note", { path: last });
    const afterDelete = await (await connect(a.port))("new_item", { title: "After a delete" });
    check("deleted-number-not-reused", afterDelete.startsWith(`Created moo-${String(max + 1).padStart(3, "0")}:`),
        `delete_note ${last}: ${JSON.stringify(del.split("\n")[0])}; next new_item: ${JSON.stringify(afterDelete.split("\n")[0])}`);

    // Measured limit: the server's create-only write re-creates a deleted path.
    const recreate = await onC("write_note", { path: last, content: "probe", create_only: true });
    console.log(`  MEASURED create_only on the deleted ${last}: ${JSON.stringify(recreate.split("\n")[0])}`);
    await onC("delete_note", { path: last });

    // Measured limit: the crash window. Item M created, its counter raise lost
    // (simulated by putting the counter back to M-1), then M deleted: M comes back.
    const m = max + 1;
    const mPath = `ToDo/items/moo-${String(m).padStart(3, "0")}.md`;
    await onC("delete_note", { path: mPath });
    const doc = await (await fetch(`${COUCH}/${OPS_DB}/${encodeURIComponent("plugin:new-item.mjs:counter")}`, { headers: couchAuth })).json() as { _rev: string; value: number };
    const lower = await fetch(`${COUCH}/${OPS_DB}/${encodeURIComponent("plugin:new-item.mjs:counter")}`, { method: "PUT", headers: { ...couchAuth, "Content-Type": "application/json" }, body: JSON.stringify({ _id: "plugin:new-item.mjs:counter", _rev: doc._rev, value: m - 1 }) });
    const crashCase = await (await connect(b.port))("new_item", { title: "After a simulated crash" });
    console.log(`  MEASURED ${mPath} deleted and counter set back ${doc.value} -> ${m - 1} (${lower.status}); next new_item: ${JSON.stringify(crashCase.split("\n")[0])}`);
} finally {
    await stopServer(a);
    await stopServer(b);
    await stopServer(c);
}

if (failures.length) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll scenarios passed.");

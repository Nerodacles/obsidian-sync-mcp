/**
 * delete_note link cleanup against a real CouchDB.
 *
 * Run: npm run test:delete-unlink   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-conc-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * Uses (drops and recreates) the database `deleteunlinkvault`.
 *
 * Scenarios (each prints PASS or FAIL; the run exits 1 on any FAIL):
 *   unlink    two notes link a third; delete_note turns both links into plain
 *             text, every other byte of the two notes stays, the third is gone,
 *             get_note_metadata of each linker lists no link to it, and the
 *             linkers read straight from CouchDB have no conflict leaf.
 *   keep      the same with unlink=false: both links are left in place.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const DB = "deleteunlinkvault";
const AUTH = "delete-unlink-test-token";
const PORT = 9891;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

let session = "";
async function post(body: unknown): Promise<Response> {
    return await fetch(`http://localhost:${PORT}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": `Bearer ${AUTH}`,
            ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
    });
}

async function connect(): Promise<void> {
    const resp = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "delete-unlink", version: "1.0" } } });
    if (!resp.ok) throw new Error(`initialize: ${resp.status}`);
    session = resp.headers.get("mcp-session-id") ?? "";
    await resp.text();
}

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
    const resp = parseSSE(await (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).text());
    const text = resp?.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name}: no text in ${JSON.stringify(resp).slice(0, 300)}`);
    return text;
}

/** The note's text from a read_note answer (after the header block). */
async function readBody(path: string): Promise<string | null> {
    const text = await tool("read_note", { path });
    if (text.startsWith("Note not found")) return null;
    const marker = "\n---\n\n";
    const at = text.indexOf(marker);
    assert.ok(at !== -1, `unexpected read_note answer: ${text.slice(0, 200)}`);
    return text.slice(at + marker.length);
}

async function couch(path: string, init: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${COUCH}/${DB}${path}`, { ...init, headers: { ...couchAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return await resp.json();
}

/** Conflict leaves of a note's document, read straight from CouchDB. */
async function conflictsOf(path: string): Promise<number> {
    const found = await couch("/_find", { method: "POST", body: JSON.stringify({ selector: { path }, conflicts: true, limit: 2 }) });
    assert.equal(found.docs?.length, 1, `expected one document for ${path}`);
    return (found.docs[0]._conflicts ?? []).length;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}

async function scenario(name: string, folder: string, unlink: boolean | undefined) {
    const target = `${folder}/Garden plan.md`;
    const a = `${folder}/Monday.md`;
    const b = `${folder}/Index.md`;
    const aText = "---\ntags: [log]\n---\n# Monday\n\nRead [[Garden plan|the plan]] first.\n`[[Garden plan]]` stays\n";
    const bText = `| Plan | Note |\n| --- | --- |\n| [[${folder}/Garden plan\\|plan]] | ok |\n\n![[Garden plan]]\n`;
    for (const [p, c] of [[target, "# Garden plan\n"], [a, aText], [b, bText]]) {
        assert.match(await tool("write_note", { path: p, content: c }), /^Note saved/);
    }
    const beforeA = await readBody(a);
    const beforeB = await readBody(b);
    check(`${name} seeded`, beforeA === aText && beforeB === bText, "read_note returns the seeded text byte for byte");

    const answer = await tool("delete_note", unlink === undefined ? { path: target } : { path: target, unlink });
    console.log(answer.split("\n").map((l) => `    | ${l}`).join("\n"));
    const afterA = await readBody(a);
    const afterB = await readBody(b);
    check(`${name} deleted`, (await readBody(target)) === null, `read_note ${target} after the delete says not found`);

    const wantA = unlink === false ? aText : aText.replace("[[Garden plan|the plan]]", "the plan");
    const wantB = unlink === false ? bText : bText.replace(`[[${folder}/Garden plan\\|plan]]`, "plan").replace("![[Garden plan]]", "Garden plan");
    check(`${name} ${a}`, afterA === wantA, JSON.stringify(afterA));
    check(`${name} ${b}`, afterB === wantB, JSON.stringify(afterB));
    for (const p of [a, b]) {
        const meta = await tool("get_note_metadata", { path: p });
        const out = meta.match(/^Outgoing links: (.*)$/m)?.[1] ?? "";
        const links = /Garden plan/.test(out);
        check(`${name} metadata ${p}`, unlink === false ? links : !links, `outgoing links: ${JSON.stringify(out)}`);
        check(`${name} conflicts ${p}`, (await conflictsOf(p)) === 0, "no conflict leaf in CouchDB");
    }
}

await fetch(`${COUCH}/${DB}`, { method: "DELETE", headers: couchAuth });
const created = await fetch(`${COUCH}/${DB}`, { method: "PUT", headers: couchAuth });
if (!created.ok) throw new Error(`could not create ${DB}: ${created.status}`);

const dataDir = await mkdtemp(join(tmpdir(), "delete-unlink-e2e-"));
let logs = "";
const proc: ChildProcess = spawn("node", ["dist/main.js"], {
    env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        MCP_AUTH_TOKEN: AUTH,
        COUCHDB_URL: COUCH,
        COUCHDB_USER: COUCH_USER,
        COUCHDB_PASSWORD: COUCH_PASSWORD,
        COUCHDB_DATABASE: DB,
        VAULT_NAME: "DeleteUnlinkVault",
        DATA_DIR: dataDir,
    },
    stdio: "pipe",
});
proc.stdout?.on("data", (d) => { logs += d.toString(); });
proc.stderr?.on("data", (d) => { logs += d.toString(); });
try {
    const start = Date.now();
    for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited:\n${logs}`);
        try { await connect(); break; } catch { /* not ready */ }
        if (Date.now() - start > 30000) throw new Error(`server did not start:\n${logs}`);
        await new Promise((r) => setTimeout(r, 250));
    }
    await scenario("unlink", "e2e-unlink", undefined);
    await scenario("keep", "e2e-keep", false);
} finally {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await rm(dataDir, { recursive: true, force: true });
}

if (failures.length) {
    console.log(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll delete_note unlink checks passed.");
process.exit(0);

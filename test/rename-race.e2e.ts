/**
 * rename_note against concurrent edits of a linking note, on a real CouchDB.
 *
 * Run: npm run test:rename-race   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-conc-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * Uses (drops and recreates) the database `renameracevault`.
 *
 * RENAME_RACE_ROUNDS (default 10) rounds: 10 edit_note appends to a note,
 * each on its own session, race one rename_note of the note it links to.
 * Every appended line must be present and the link rewritten to the new
 * path (lines are counted: a lost append leaves no conflict leaf to see).
 * Prints PASS or FAIL per check; exits 1 on any FAIL.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const DB = "renameracevault";
const AUTH = "rename-race-test-token";
const PORT = 9892;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

/** One MCP session; concurrent calls each get their own, as in the concurrency harness. */
class Client {
    private session = "";

    private async post(body: unknown): Promise<Response> {
        return await fetch(`http://localhost:${PORT}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${AUTH}`,
                ...(this.session ? { "mcp-session-id": this.session } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    async connect(): Promise<this> {
        const resp = await this.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "rename-race", version: "1.0" } } });
        if (!resp.ok) throw new Error(`initialize: ${resp.status}`);
        this.session = resp.headers.get("mcp-session-id") ?? "";
        await resp.text();
        return this;
    }

    async tool(name: string, args: Record<string, unknown>): Promise<string> {
        const resp = parseSSE(await (await this.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).text());
        const text = resp?.result?.content?.[0]?.text;
        if (typeof text !== "string") throw new Error(`${name}: no text in ${JSON.stringify(resp).slice(0, 300)}`);
        return text;
    }
}

let main: Client;
const tool = (name: string, args: Record<string, unknown>) => main.tool(name, args);

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

async function race(rounds: number) {
    const workers = await Promise.all(Array.from({ length: 11 }, () => new Client().connect()));
    let lost = 0;
    let stale = 0;
    let leaves = 0;
    for (let r = 0; r < rounds; r++) {
        const from = `race/${r}/Garden plan.md`;
        const to = `race/${r}/Spring planting.md`;
        const linker = `race/${r}/Log.md`;
        assert.match(await tool("write_note", { path: from, content: "x\n" }), /^Note saved/);
        assert.match(await tool("write_note", { path: linker, content: `See [[race/${r}/Garden plan|the plan]]\n` }), /^Note saved/);
        const appends = Array.from({ length: 10 }, (_, i) => `line-${r}-${i}`);
        const answers = await Promise.all([
            workers[0].tool("rename_note", { from, to }),
            ...appends.map((line, i) => workers[i + 1].tool("edit_note", { path: linker, content: line })),
        ]);
        assert.match(answers[0], /^Renamed: /, answers[0]);
        for (const a of answers.slice(1)) assert.match(a, /^Note edited/, a);
        const text = (await readBody(linker)) ?? "";
        const missing = appends.filter((l) => !text.includes(l)).length;
        lost += missing;
        const rewritten = text.includes(`[[race/${r}/Spring planting|the plan]]`);
        if (!rewritten) stale++;
        leaves += await conflictsOf(linker);
        if (missing > 0 || !rewritten) console.log(`    round ${r}: ${missing} appends missing, link ${rewritten ? "rewritten" : "NOT rewritten"}; ${answers[0].split("\n").filter((l) => /^(Links|- )/.test(l)).join(" | ")}`);
    }
    check("race appends", lost === 0, `${lost} of ${rounds * 10} appends missing after racing rename_note`);
    check("race conflicts", leaves === 0, `${leaves} conflict leaves on the linking notes`);
    check("race rewritten", stale === 0, `${stale} of ${rounds} rounds left the link on the old path`);
}

await fetch(`${COUCH}/${DB}`, { method: "DELETE", headers: couchAuth });
const created = await fetch(`${COUCH}/${DB}`, { method: "PUT", headers: couchAuth });
if (!created.ok) throw new Error(`could not create ${DB}: ${created.status}`);

const dataDir = await mkdtemp(join(tmpdir(), "rename-race-e2e-"));
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
        VAULT_NAME: "RenameRaceVault",
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
        try { main = await new Client().connect(); break; } catch { /* not ready */ }
        if (Date.now() - start > 30000) throw new Error(`server did not start:\n${logs}`);
        await new Promise((r) => setTimeout(r, 250));
    }
    await race(Number(process.env.RENAME_RACE_ROUNDS ?? 10));
} finally {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await rm(dataDir, { recursive: true, force: true });
}

if (failures.length) {
    console.log(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll rename_note race checks passed.");
process.exit(0);

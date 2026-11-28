/**
 * op_id harness: a retried write applies once, across two server instances
 * on one CouchDB database and across a restart.
 *
 * Destructive: drops and recreates its own two test databases. Never point it
 * at a real vault.
 *
 * Run: npm run test:idempotency   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-idem-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * Each scenario prints PASS or FAIL; the run exits 1 on any FAIL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const DB = "idemvault";
const OPS_DB = "idemops";
const AUTH = "idempotency-test-token";
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

async function connect(port: number): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${AUTH}` };
    const init = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "idempotency", version: "1.0" } } }) });
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

interface Server { proc: ChildProcess; logs: string; dataDir: string; port: number }

async function startServer(port: number, env: Record<string, string> = {}): Promise<Server> {
    const dataDir = await mkdtemp(join(tmpdir(), "idem-e2e-"));
    const server: Server = {
        proc: spawn("node", ["dist/main.js"], {
            env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_AUTH_TOKEN: AUTH, COUCHDB_URL: COUCH, COUCHDB_USER: COUCH_USER, COUCHDB_PASSWORD: COUCH_PASSWORD, COUCHDB_DATABASE: DB, VAULT_NAME: "IdemVault", DATA_DIR: dataDir, OPS_DATABASE: OPS_DB, ...env },
            stdio: "pipe",
        }),
        logs: "",
        dataDir,
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
    await rm(server.dataDir, { recursive: true, force: true });
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}
const count = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

for (const db of [DB, OPS_DB]) await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: couchAuth });
const created = await fetch(`${COUCH}/${DB}`, { method: "PUT", headers: couchAuth });
if (!created.ok) throw new Error(`could not create ${DB}: ${created.status}`);

let a = await startServer(9891);
const b = await startServer(9892);
try {
    const opsDb = await fetch(`${COUCH}/${OPS_DB}`, { headers: couchAuth });
    check("ops-database", opsDb.ok, `${OPS_DB} ${opsDb.ok ? "exists" : `missing (${opsDb.status})`} after startup`);

    const onA = await connect(a.port);
    const onB = await connect(b.port);
    const path = "Inbox/tasks.md";
    await onA("write_note", { path, content: "# Tasks\n" });

    const call = { path, content: "- [ ] water the plants", op_id: "retry-1" };
    const first = await onA("edit_note", call);
    const fromB = await onB("edit_note", call);
    let body = await onB("read_note", { path });
    check("two-instances", count(body, "- [ ] water the plants") === 1 && fromB === first,
        `line present ${count(body, "- [ ] water the plants")}x after A then B; same answer: ${fromB === first}`);

    await stopServer(a);
    a = await startServer(9891);
    const afterRestart = await (await connect(a.port))("edit_note", call);
    body = await onB("read_note", { path });
    check("restart", count(body, "- [ ] water the plants") === 1 && afterRestart === first,
        `line present ${count(body, "- [ ] water the plants")}x after a restart of A; same answer: ${afterRestart === first}`);

    const both = { path, content: "- [ ] feed the cat", op_id: "retry-2" };
    const answers = await Promise.all([(await connect(a.port))("edit_note", both), onB("edit_note", both)]);
    body = await onB("read_note", { path });
    check("simultaneous", count(body, "- [ ] feed the cat") === 1,
        `line present ${count(body, "- [ ] feed the cat")}x after the same op_id hit both instances at once; answers: ${JSON.stringify(answers.map((x) => x.split("\n")[0].slice(0, 80)))}`);

    const other = await onB("edit_note", { ...call, content: "- [ ] something else" });
    body = await onB("read_note", { path });
    check("reused-id", /already used for a different call/.test(other) && count(body, "- [ ] something else") === 0,
        `reused op_id with other arguments: ${JSON.stringify(other.split("\n")[0].slice(0, 80))}`);

    const onNewA = await connect(a.port);
    await onNewA("edit_note", { path, content: "- [ ] no key" });
    await onNewA("edit_note", { path, content: "- [ ] no key" });
    body = await onB("read_note", { path });
    check("no-op-id", count(body, "- [ ] no key") === 2, `without op_id two calls write ${count(body, "- [ ] no key")}x (unchanged behaviour)`);
} finally {
    await stopServer(a);
    await stopServer(b);
}

if (failures.length) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll op_id scenarios passed.");
process.exit(0);

/**
 * The desk-answer-webhook plugin against a real CouchDB, through the server's
 * own changes feed: instance A loads the plugin; instance B (no plugin) writes
 * the case notes, so A sees each edit only through CouchDB, as it sees an edit
 * made in Obsidian and replicated by LiveSync. A local HTTP listener stands in
 * for the receiver, checks the signature and records every event.
 *
 * Destructive: drops and recreates its own test databases. Never point it at
 * a real vault.
 *
 * Run: npm run test:desk-answer   (builds first, then expects CouchDB on localhost:5993)
 *
 *   docker run -d --name couchdb-desk -p 127.0.0.1:5993:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3.5.3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD;
 * DESK_PLUGIN loads another plugin file instead (to show the run fails on a
 * broken variant). Each scenario prints PASS or FAIL; exit 1 on any FAIL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5993").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const PLUGIN = resolve(process.env.DESK_PLUGIN ?? "examples/desk-answer-webhook.mjs");
const DB = "deskvault";
const OPS_DB = "deskops";
const AUTH = "desk-answer-test-token";
const SECRET = "e2e-secret-that-is-at-least-32-characters";
const PATH = "ToDo/items/moo-901.md";
const QUIET_MS = 4000;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

// --- the receiver stand-in ---
const events: { at: number; body: any; signed: boolean }[] = [];
const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
        const ts = String(req.headers["x-desk-timestamp"] ?? "");
        const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
        const signed = req.headers["x-desk-signature"] === expected;
        events.push({ at: Date.now(), body: JSON.parse(raw), signed });
        res.writeHead(signed ? 202 : 401).end();
    });
});
await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
const RECEIVER_URL = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/desk-answer`;

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
    const init = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desk-answer", version: "1.0" } } }) });
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

async function startServer(port: number, withPlugin: boolean, dataDir?: string): Promise<Server> {
    const data = dataDir ?? await mkdtemp(join(tmpdir(), "desk-e2e-"));
    const dirs = dataDir ? [] : [data];
    const extra: Record<string, string> = {};
    if (withPlugin) {
        const pluginDir = await mkdtemp(join(tmpdir(), "desk-plugins-"));
        await copyFile(PLUGIN, join(pluginDir, "desk-answer-webhook.mjs"));
        dirs.push(pluginDir);
        Object.assign(extra, { PLUGIN_DIR: pluginDir, DESK_WEBHOOK_URL: RECEIVER_URL, DESK_WEBHOOK_SECRET: SECRET });
    }
    const server: Server = {
        proc: spawn("node", ["dist/main.js"], {
            env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_AUTH_TOKEN: AUTH, COUCHDB_URL: COUCH, COUCHDB_USER: COUCH_USER, COUCHDB_PASSWORD: COUCH_PASSWORD, COUCHDB_DATABASE: DB, VAULT_NAME: "Desk Vault", DATA_DIR: data, OPS_DATABASE: OPS_DB, ...extra },
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
        try {
            await connect(port);
            if (!withPlugin || /startup sweep:/.test(server.logs) || /desk-answer-webhook\.mjs\] off:/.test(server.logs)) return server;
        } catch { /* not ready */ }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until `n` events in total arrived (or the timeout), then a quiet period to catch extras. */
async function settle(n: number, timeoutMs = 15000): Promise<number> {
    const t0 = Date.now();
    while (events.length < n && Date.now() - t0 < timeoutMs) await sleep(100);
    await sleep(QUIET_MS);
    return events.length;
}

function note({ go = "false", answer = '""', body = "Body." } = {}) {
    return `---\nid: moo-901\ntitle: "Desk e2e"\nask: "Ship it?"\nrecommended: "yes"\ngo: ${go}\nanswer: ${answer}\nstate: "doing"\n---\n\n# moo-901\n\n${body}\n`;
}

for (const db of [DB, OPS_DB]) await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: couchAuth });
for (const db of [DB, OPS_DB]) {
    const created = await fetch(`${COUCH}/${db}`, { method: "PUT", headers: couchAuth });
    if (!created.ok) throw new Error(`could not create ${db}: ${created.status}`);
}

const aData = await mkdtemp(join(tmpdir(), "desk-e2e-a-"));
const b = await startServer(9912, false);
const writeB = await connect(b.port);
let a = await startServer(9911, true, aData);
try {
    check("plugin-on", /\[desk-answer-webhook\.mjs\] on: answers in ToDo\/items\//.test(a.logs), a.logs.match(/\[desk-answer-webhook\.mjs\].*/)?.[0] ?? "no plugin line");

    await writeB("write_note", { path: PATH, content: note() });
    check("no-answer-no-event", (await settle(1, 3000)) === 0, `case created with go false: ${events.length} events`);

    const t0 = Date.now();
    await writeB("write_note", { path: PATH, content: note({ go: "true" }) });
    const n1 = await settle(1);
    const first = events[0];
    check("go-fires-once", n1 === 1 && first?.body.kind === "go" && first?.signed, `go false -> true: ${n1} events ${JSON.stringify(events.map((e) => e.body))}, signed ${first?.signed}, ${first ? first.at - t0 : "-"} ms after the write`);
    check("payload-shape", first && JSON.stringify(Object.keys(first.body)) === '["path","id","revision","kind"]' && first.body.path === PATH && first.body.id === "moo-901" && /^\d+-[0-9a-f]+$/.test(first.body.revision), JSON.stringify(first?.body));

    await writeB("write_note", { path: PATH, content: note({ go: "true", body: "Unrelated edit." }) });
    check("unrelated-edit-silent", (await settle(2, 3000)) === 1, `body edit with go still true: ${events.length} events in total`);

    await writeB("write_note", { path: PATH, content: note({ go: "false", answer: '"ship on Monday"' }) });
    const n2 = await settle(2);
    check("answer-fires-once", n2 === 2 && events[1]?.body.kind === "answer", `answer "" -> text: ${n2} events in total, last ${JSON.stringify(events[1]?.body)}`);

    await writeB("write_note", { path: PATH, content: note({ go: "false", answer: '"ship on Monday"', body: "Saved again." }) });
    check("same-answer-silent", (await settle(3, 3000)) === 2, `same answer re-saved: ${events.length} events in total`);

    await stopServer(a);
    a = await startServer(9911, true, aData);
    check("restart-silent", (await settle(3, 3000)) === 2, `restart: ${events.length} events in total; ${a.logs.match(/startup sweep:.*/)?.[0]}`);

    await stopServer(a);
    await writeB("write_note", { path: PATH, content: note({ go: "false", answer: '"no, wait"' }) });
    a = await startServer(9911, true, aData);
    const n3 = await settle(3);
    check("answer-while-down-fires-once", n3 === 3 && events[2]?.body.kind === "answer", `answer changed while A was down: ${n3} events in total; ${a.logs.match(/startup sweep:.*/)?.[0]}`);

    // A session clears the case through the plugin's own instance; the owner ticks go again in Obsidian.
    const writeA = await connect(a.port);
    await writeA("write_note", { path: PATH, content: note() });
    await sleep(1500);
    await writeB("write_note", { path: PATH, content: note({ go: "true" }) });
    const n4 = await settle(4);
    check("own-clear-seen-then-tick-fires", n4 === 4 && events[3]?.body.kind === "go", `cleared through A, go ticked through B: ${n4} events in total; A log: ${a.logs.match(/\[desk-answer-webhook\.mjs\] sent go.*/g)?.at(-1) ?? "no send line"}`);
} finally {
    await stopServer(a).catch(() => undefined);
    await stopServer(b);
    await rm(aData, { recursive: true, force: true });
    receiver.close();
}

if (failures.length) {
    console.log(`\n${failures.length} FAIL: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nall PASS");

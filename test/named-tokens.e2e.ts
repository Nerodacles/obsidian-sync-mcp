/**
 * MCP_TOKENS_FILE harness: one server, several named bearer tokens, each with
 * its own write permissions, against a local (VAULT_PATH) vault. No CouchDB.
 *
 * Run: npm run test:named-tokens   (builds first)
 *
 * Each scenario prints PASS or FAIL; the run exits 1 on any FAIL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9895;
const BASE = `http://localhost:${PORT}/mcp`;
const digest = (token: string) => "sha256:" + createHash("sha256").update(token).digest("hex");

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    try { return JSON.parse(raw); } catch { return null; }
}

const headers = (token: string) => ({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": `Bearer ${token}` });
const initBody = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tokens", version: "1.0" } } });

async function initStatus(token: string): Promise<number> {
    const resp = await fetch(BASE, { method: "POST", headers: headers(token), body: initBody });
    await resp.text();
    return resp.status;
}

async function connect(token: string): Promise<(name: string, args: Record<string, unknown>) => Promise<string>> {
    const init = await fetch(BASE, { method: "POST", headers: headers(token), body: initBody });
    if (!init.ok) throw new Error(`initialize: ${init.status}`);
    const session = init.headers.get("mcp-session-id") ?? "";
    await init.text();
    return async (name, args) => {
        const resp = await fetch(BASE, { method: "POST", headers: { ...headers(token), "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const text = parseSSE(await resp.text())?.result?.content?.[0]?.text;
        return typeof text === "string" ? text : `(HTTP ${resp.status})`;
    };
}

let proc: ChildProcess | null = null;
let logs = "";
async function start(env: Record<string, string>): Promise<void> {
    logs = "";
    proc = spawn("node", ["dist/main.js"], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ...env }, stdio: "pipe" });
    proc.stdout?.on("data", (d) => { logs += d.toString(); });
    proc.stderr?.on("data", (d) => { logs += d.toString(); });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
        if (proc.exitCode !== null) throw new Error(`server exited:\n${logs}`);
        // The log line can come before the port is bound, so wait for an HTTP answer.
        if (/listening on port/.test(logs)) {
            try { await fetch(BASE, { method: "POST", body: "{}" }); return; } catch { /* not bound yet */ }
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not start:\n${logs}`);
}
async function stop(): Promise<void> {
    if (!proc) return;
    if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => proc!.once("exit", r));
    }
    proc = null;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}

const dir = await mkdtemp(join(tmpdir(), "tokens-e2e-"));
const vault = join(dir, "vault");
await mkdir(join(vault, "Inbox"), { recursive: true });
await mkdir(join(vault, "Projects"), { recursive: true });
await writeFile(join(vault, "Projects/plan.md"), "plan");
const tokensFile = join(dir, "tokens");
const env = { VAULT_PATH: vault, DATA_DIR: join(dir, "data"), MCP_TOKENS_FILE: tokensFile };

try {
    await writeFile(tokensFile, [
        `alice ${digest("alice-token")} Inbox:create+update`,
        `bob ${digest("bob-token")} -`,
        `carol ${digest("carol-old")} Projects`,
        `carol ${digest("carol-new")} Projects`,
    ].join("\n"));
    await start(env);
    check("file-holds-no-token", !(await readFile(tokensFile, "utf8")).includes("alice-token"), "the tokens file holds digests only");
    check("unknown-token", (await initStatus("nobody-token")) === 401, `unknown token answers ${await initStatus("nobody-token")}`);

    const alice = await connect("alice-token");
    const own = await alice("write_note", { path: "Inbox/note.md", content: "from alice" });
    const outside = await alice("write_note", { path: "Projects/plan.md", content: "overwritten by alice" });
    const plan = await readFile(join(vault, "Projects/plan.md"), "utf8");
    check("own-permissions", own.startsWith("Note saved") && !outside.startsWith("Note saved") && plan === "plan",
        `inside: ${JSON.stringify(own.split("\n")[0])}; outside: ${JSON.stringify(outside.split("\n")[0].slice(0, 90))}`);

    const bob = await connect("bob-token");
    const bobWrite = await bob("write_note", { path: "Inbox/bob.md", content: "x" });
    check("read-only-token", !bobWrite.startsWith("Note saved") && (await bob("read_note", { path: "Inbox/note.md" })).endsWith("from alice"),
        `write: ${JSON.stringify(bobWrite.split("\n")[0].slice(0, 90))}; reads work`);

    // A session opened with one token and then used with another runs as the
    // token of each request: bob can't borrow alice's session to write.
    const opened = await fetch(BASE, { method: "POST", headers: headers("alice-token"), body: initBody });
    const sid = opened.headers.get("mcp-session-id") ?? "";
    await opened.text();
    const borrowed = await fetch(BASE, { method: "POST", headers: { ...headers("bob-token"), "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_note", arguments: { path: "Inbox/borrowed.md", content: "x" } } }) });
    const borrowedText = String(parseSSE(await borrowed.text())?.result?.content?.[0]?.text);
    let written = true;
    try { await readFile(join(vault, "Inbox/borrowed.md")); } catch { written = false; }
    check("session-follows-token", !borrowedText.startsWith("Note saved") && !written, `bob on alice's session: ${JSON.stringify(borrowedText.slice(0, 80))}`);

    const old = await connect("carol-old");
    const fresh = await connect("carol-new");
    const a = await old("edit_note", { path: "Projects/plan.md", content: "old token" });
    const b = await fresh("edit_note", { path: "Projects/plan.md", content: "new token" });
    check("rotation-both-valid", a.startsWith("Note edited") && b.startsWith("Note edited"), "old and new token of carol both write");

    await stop();
    await writeFile(tokensFile, [
        `alice ${digest("alice-token")} Inbox:create+update`,
        `bob ${digest("bob-token")} -`,
        `carol ${digest("carol-new")} Projects`,
    ].join("\n"));
    await start(env);
    const oldStatus = await initStatus("carol-old");
    const newStatus = await initStatus("carol-new");
    check("rotation-old-removed", oldStatus === 401 && newStatus === 200, `after removing the old digest: old ${oldStatus}, new ${newStatus}`);

    await stop();
    await writeFile(tokensFile, `alice alice-token *`);
    let refused = false;
    try { await start(env); } catch (err) { refused = /never the token itself/.test(String(err)) && !String(err).includes("alice-token *"); }
    check("plaintext-refused", refused, "a token written in place of its digest stops startup without echoing it");
} finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll named-token scenarios passed.");
process.exit(0);

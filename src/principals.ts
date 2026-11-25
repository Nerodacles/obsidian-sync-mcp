/**
 * Named bearer tokens (MCP_TOKENS_FILE): several callers on one server, each
 * with a name and its own write permissions.
 *
 * One line per token:
 *
 *   <name> sha256:<64 hex digits> <permissions>
 *
 * - The digest is SHA-256 of the token, so the file never holds a usable
 *   token: `printf %s "$TOKEN" | sha256sum`.
 * - <permissions> is `*` (write anywhere), `-` (read-only), or a
 *   WRITE_FOLDERS value without spaces, e.g. `Inbox:create,Projects`.
 * - A name may appear on two or more lines with the same permissions: each
 *   digest is valid, which is how a token is rotated (add the new one,
 *   restart, move the clients over, remove the old one, restart).
 * - Blank lines and lines starting with `#` are ignored.
 *
 * The name reaches the tools (currentPrincipal) for logs and provenance.
 * Kept dependency-free apart from write-scope so it is unit-testable in isolation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { parseWriteFolders, type WriteScope } from "./write-scope.js";

export interface Principal {
    name: string;
    /** The permissions text as written in the file. */
    permissions: string;
    scope: WriteScope;
    digest: Buffer;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;

/** `*` = unrestricted (null), `-` = nothing writable ([]), else WRITE_FOLDERS syntax. */
function parsePermissions(text: string, where: string): WriteScope {
    if (text === "*") return null;
    if (text === "-") return [];
    try {
        return parseWriteFolders(text);
    } catch (err) {
        throw new Error(`${where}: ${(err as Error).message}`);
    }
}

export function parsePrincipals(text: string, source = "MCP_TOKENS_FILE"): Principal[] {
    const principals: Principal[] = [];
    const permissionsByName = new Map<string, string>();
    const digests = new Set<string>();
    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) return;
        const where = `${source} line ${i + 1}`;
        const fields = line.split(/\s+/);
        if (fields.length !== 3) throw new Error(`${where}: expected '<name> sha256:<hex> <permissions>', got ${fields.length} fields.`);
        const [name, digestField, permissions] = fields;
        if (!NAME.test(name)) throw new Error(`${where}: name must be 1-64 characters of A-Z a-z 0-9 . _ -`);
        const digest = DIGEST.exec(digestField.toLowerCase());
        // Never echo the field: it may be a token pasted by mistake.
        if (!digest) throw new Error(`${where}: the second field must be sha256:<64 hex digits>, the SHA-256 of the token, never the token itself.`);
        if (digests.has(digest[1])) throw new Error(`${where}: this digest is already listed.`);
        digests.add(digest[1]);
        const earlier = permissionsByName.get(name);
        if (earlier !== undefined && earlier !== permissions) {
            throw new Error(`${where}: ${name} is listed again with other permissions; rotate a token by repeating the same permissions.`);
        }
        permissionsByName.set(name, permissions);
        principals.push({ name, permissions, scope: parsePermissions(permissions, where), digest: Buffer.from(digest[1], "hex") });
    });
    if (principals.length === 0) throw new Error(`${source}: no tokens listed.`);
    return principals;
}

/**
 * The principal whose token is in `Authorization: Bearer <token>`, or null.
 * Compares the token's digest with every listed digest in constant time, without stopping at a match.
 */
export function matchPrincipal(principals: readonly Principal[], header: string | string[] | undefined): Principal | null {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const presented = createHash("sha256").update(header.slice("Bearer ".length), "utf8").digest();
    let found: Principal | null = null;
    for (const p of principals) {
        if (timingSafeEqual(presented, p.digest) && !found) found = p;
    }
    return found;
}

/** Who is calling and what they may write, for the duration of one tool call. */
interface CallScope {
    principal: string;
    scope: WriteScope;
}
const callScope = new AsyncLocalStorage<CallScope>();

export function runAsPrincipal<T>(principal: string, scope: WriteScope, fn: () => T): T {
    return callScope.run({ principal, scope }, fn);
}

/** The write scope of the current tool call when named tokens are in use, else `fallback`. */
export function currentWriteScope(fallback: WriteScope): WriteScope {
    const s = callScope.getStore();
    return s ? s.scope : fallback;
}

/** The token name of the current tool call, when named tokens are in use. */
export function currentPrincipal(): string | undefined {
    return callScope.getStore()?.principal;
}

export function describePrincipals(principals: readonly Principal[]): string {
    const byName = new Map<string, { permissions: string; tokens: number }>();
    for (const p of principals) {
        const e = byName.get(p.name) ?? { permissions: p.permissions, tokens: 0 };
        e.tokens++;
        byName.set(p.name, e);
    }
    return [...byName.entries()].map(([n, e]) => `${n} (${e.permissions}${e.tokens > 1 ? `, ${e.tokens} tokens` : ""})`).join(", ");
}

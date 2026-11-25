import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { currentPrincipal, currentWriteScope, describePrincipals, matchPrincipal, parsePrincipals, runAsPrincipal } from "./principals.js";
import { allowedActions } from "./write-scope.js";

const digest = (token: string) => "sha256:" + createHash("sha256").update(token).digest("hex");

describe("parsePrincipals", () => {
    it("reads names, digests and permissions; skips comments and blank lines", () => {
        const ps = parsePrincipals(`# agents\n\nalice ${digest("a1")} Inbox:create,Projects\nbob ${digest("b1")} -\nops ${digest("o1")} *\n`);
        assert.deepEqual(ps.map((p) => [p.name, p.permissions]), [["alice", "Inbox:create,Projects"], ["bob", "-"], ["ops", "*"]]);
        assert.deepEqual([...allowedActions("Inbox/x.md", ps[0].scope)], ["create"]);
        assert.deepEqual([...allowedActions("Projects/x.md", ps[0].scope)].sort(), ["create", "delete", "update"]);
        assert.deepEqual([...allowedActions("Other/x.md", ps[0].scope)], []);
        assert.deepEqual([...allowedActions("Inbox/x.md", ps[1].scope)], [], "- is read-only");
        assert.equal(ps[2].scope, null, "* is unrestricted");
    });

    it("refuses a token written in place of its digest, without echoing it", () => {
        assert.throws(() => parsePrincipals("alice my-secret-token *"), (e: Error) => /never the token itself/.test(e.message) && !e.message.includes("my-secret-token"));
    });

    it("refuses bad names, field counts, permissions, repeated digests and empty files", () => {
        assert.throws(() => parsePrincipals(`al ice ${digest("a")} *`), /expected '<name> sha256:<hex> <permissions>'/);
        assert.throws(() => parsePrincipals(`ali/ce ${digest("a")} *`), /name must be/);
        assert.throws(() => parsePrincipals(`alice ${digest("a")} Inbox:erase`), /line 1: WRITE_FOLDERS: unknown permission 'erase'/);
        assert.throws(() => parsePrincipals(`alice ${digest("a")} *\nbob ${digest("a")} *`), /line 2: this digest is already listed/);
        assert.throws(() => parsePrincipals("# nothing\n"), /no tokens listed/);
    });

    it("rotation: a name may list two tokens, with the same permissions only", () => {
        const ps = parsePrincipals(`carol ${digest("old")} Inbox\ncarol ${digest("new")} Inbox`);
        assert.equal(describePrincipals(ps), "carol (Inbox, 2 tokens)");
        assert.throws(() => parsePrincipals(`carol ${digest("old")} Inbox\ncarol ${digest("new")} *`), /listed again with other permissions/);
    });
});

describe("matchPrincipal", () => {
    const ps = parsePrincipals(`alice ${digest("a1")} Inbox\ncarol ${digest("old")} -\ncarol ${digest("new")} -`);
    it("finds the token's principal; an unknown or malformed header finds none", () => {
        assert.equal(matchPrincipal(ps, "Bearer a1")?.name, "alice");
        assert.equal(matchPrincipal(ps, "Bearer old")?.name, "carol");
        assert.equal(matchPrincipal(ps, "Bearer new")?.name, "carol");
        assert.equal(matchPrincipal(ps, "Bearer a2"), null);
        assert.equal(matchPrincipal(ps, "a1"), null);
        assert.equal(matchPrincipal(ps, "Basic a1"), null);
        assert.equal(matchPrincipal(ps, undefined), null);
        assert.equal(matchPrincipal(ps, ["Bearer a1"]), null);
    });
});

describe("call scope", () => {
    it("holds the principal and scope for the call, and falls back outside one", async () => {
        assert.equal(currentWriteScope(null), null);
        assert.equal(currentPrincipal(), undefined);
        await runAsPrincipal("bob", [], async () => {
            await new Promise((r) => setTimeout(r, 1));
            assert.deepEqual(currentWriteScope(null), []);
            assert.equal(currentPrincipal(), "bob");
        });
    });
});

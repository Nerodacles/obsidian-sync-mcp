import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addAlias, resolveLink, rewriteLinks, type RenameContext } from "./rename.js";

const FROM = "Projects/Garden plan.md";
const TO = "Projects/Garden/Spring planting.md";

function ctx(source: string, notes: string[] = [FROM, source], over: Partial<RenameContext> = {}): RenameContext {
    return { from: FROM, to: TO, notesBefore: notes, sourceBefore: source, sourceAfter: source, ...over };
}

const rewrite = (text: string, source = "Journal/Monday.md", notes?: string[]) => rewriteLinks(text, ctx(source, notes));

describe("resolveLink", () => {
    const notes = [FROM, "Archive/Seeds.md", "Projects/Seeds.md", "Journal/Monday.md"];
    it("resolves vault paths, names, relative paths, case-insensitively", () => {
        assert.equal(resolveLink("Projects/Garden plan", "Journal/Monday.md", notes), FROM);
        assert.equal(resolveLink("garden PLAN.md", "Journal/Monday.md", notes), FROM);
        assert.equal(resolveLink("../Projects/Garden plan.md", "Journal/Monday.md", notes), FROM);
        assert.equal(resolveLink("./Garden plan", "Projects/Index.md", notes), FROM);
        assert.equal(resolveLink("Missing", "Journal/Monday.md", notes), null);
    });
    it("prefers the source's folder, else reports a shared name as ambiguous", () => {
        assert.equal(resolveLink("Seeds", "Projects/Index.md", notes), "Projects/Seeds.md");
        assert.equal(resolveLink("Seeds", "Journal/Monday.md", notes), "ambiguous");
    });
});

describe("rewriteLinks", () => {
    it("counts each rewritten link", () => {
        const r = rewrite("[[Garden plan]] [[Garden plan|x]] [[Other]]\n");
        assert.equal(r.content, "[[Spring planting]] [[Spring planting|x]] [[Other]]\n");
        assert.equal(r.rewritten, 2);
    });

    it("keeps relative paths relative to the linking note", () => {
        assert.equal(rewrite("[a](../Projects/Garden%20plan.md)").content, "[a](../Projects/Garden/Spring%20planting.md)");
        assert.equal(rewrite("[a](./Garden%20plan.md)", "Projects/Index.md").content, "[a](./Garden/Spring%20planting.md)");
    });

    it("keeps a markdown link by bare file name relative to the linking note's folder", () => {
        assert.equal(rewrite("[a](Garden%20plan.md)", "Projects/Index.md").content, "[a](Garden/Spring%20planting.md)");
        assert.equal(rewrite("[a](Garden%20plan.md)", "Journal/Monday.md").content, "[a](Spring%20planting.md)", "found by name, so written by name");
    });

    it("encodes a markdown link whose new path needs it, even when the old one didn't", () => {
        const r = rewriteLinks("[a](Projects/Plan.md)", { from: "Projects/Plan.md", to: "Projects/Big (2) plan.md", notesBefore: ["Projects/Plan.md"], sourceBefore: "Journal/Monday.md", sourceAfter: "Journal/Monday.md" });
        assert.equal(r.content, "[a](Projects/Big%20%282%29%20plan.md)");
    });

    it("keeps a link title and leaves external links alone", () => {
        assert.equal(rewrite('[a](Projects/Garden%20plan.md "Plan") [b](https://example.com/Garden%20plan.md)').content,
            '[a](Projects/Garden/Spring%20planting.md "Plan") [b](https://example.com/Garden%20plan.md)');
    });

    it("writes the full path when the new name is already taken", () => {
        const notes = [FROM, "Archive/Spring planting.md", "Journal/Monday.md"];
        assert.equal(rewrite("[[Garden plan]]", "Journal/Monday.md", notes).content, "[[Projects/Garden/Spring planting]]");
    });

    it("rewrites wikilinks in properties but not markdown-looking text there", () => {
        const text = "---\nrelated: \"[[Garden plan]]\"\nsrc: \"[x](Projects/Garden%20plan.md)\"\n---\n[[Garden plan]]\n";
        assert.equal(rewrite(text).content, "---\nrelated: \"[[Spring planting]]\"\nsrc: \"[x](Projects/Garden%20plan.md)\"\n---\n[[Spring planting]]\n");
    });

    it("skips every code form: ``` and ~~~ fences, fences in quotes, double-backtick spans", () => {
        const text = [
            "~~~md", "[[Garden plan]]", "~~~",
            "> ```", "> [[Garden plan]]", "> ```",
            "``a `[[Garden plan]]` b``",
            "[[Garden plan]]",
        ].join("\n");
        const r = rewrite(text);
        assert.equal(r.rewritten, 1);
        assert.ok(r.content.endsWith("\n[[Spring planting]]"));
    });

    it("an escaped or unclosed backtick opens no code span", () => {
        assert.equal(rewrite("\\`[[Garden plan]]\\`").content, "\\`[[Spring planting]]\\`");
        assert.equal(rewrite("a ` b [[Garden plan]]").content, "a ` b [[Spring planting]]");
        assert.equal(rewrite("`x\n\n[[Garden plan]] `").content, "`x\n\n[[Spring planting]] `", "a span doesn't cross a blank line");
    });

    it("checks code and frontmatter against the original text when a rename shortens links", () => {
        const shorter = (text: string) => rewriteLinks(text, { ...ctx("Journal/Monday.md"), to: "Projects/Plan.md" }).content;
        assert.equal(shorter("[[Garden plan]] `[x](Projects/Garden%20plan.md)`\n"), "[[Plan]] `[x](Projects/Garden%20plan.md)`\n");
        assert.equal(shorter("[[Garden plan]] [[Garden plan]]\n```\ncode\n```\n[x](Projects/Garden%20plan.md)\n"),
            "[[Plan]] [[Plan]]\n```\ncode\n```\n[x](Projects/Plan.md)\n");
        assert.equal(shorter("---\nup: \"[[Garden plan]]\"\n---\n[x](Projects/Garden%20plan.md)\n"), "---\nup: \"[[Plan]]\"\n---\n[x](Projects/Plan.md)\n");
    });

    it("keeps CRLF line endings", () => {
        assert.equal(rewrite("a\r\n[[Garden plan]]\r\n").content, "a\r\n[[Spring planting]]\r\n");
    });

    it("rewrites a note's links to itself from its new place", () => {
        const r = rewriteLinks("See [[#Beds]] and [[Garden plan#Beds]].", { ...ctx(FROM, [FROM]), sourceAfter: TO });
        assert.equal(r.content, "See [[#Beds]] and [[Spring planting#Beds]].");
    });

    it("leaves links to other notes byte-identical", () => {
        const text = "[[Garden]] [[Garden plan 2]] [x](Projects/Other.md) ![[img.png]]\n";
        const r = rewrite(text, "Journal/Monday.md", [FROM, "Projects/Garden plan 2.md", "Garden.md", "Projects/Other.md"]);
        assert.equal(r.content, text);
        assert.equal(r.rewritten, 0);
    });
});

describe("addAlias", () => {
    const added = (content: string, alias = "Garden plan") => {
        const r = addAlias(content, alias);
        assert.equal(r.status, "added");
        return (r as { content: string }).content;
    };

    it("creates the property in frontmatter without it", () => {
        assert.equal(added("---\ntitle: Garden\n---\nBody"), "---\ntitle: Garden\naliases:\n  - Garden plan\n---\nBody");
    });

    it("fills empty frontmatter", () => {
        assert.equal(added("---\n---\nBody"), "---\naliases:\n  - Garden plan\n---\nBody");
    });

    it("appends to a flow list, an empty flow list and a block list with its indentation", () => {
        assert.equal(added("---\naliases: [Beds, Seeds]\n---\n"), "---\naliases: [Beds, Seeds, Garden plan]\n---\n");
        assert.equal(added("---\naliases: []\n---\n"), "---\naliases: [Garden plan]\n---\n");
        assert.equal(added("---\naliases:\n    - Beds # first\nx: 1\n---\n"), "---\naliases:\n    - Beds # first\n    - Garden plan\nx: 1\n---\n");
    });

    it("turns a single value into a list and fills an empty one", () => {
        assert.equal(added("---\naliases: Beds\n---\n"), "---\naliases: [Beds, Garden plan]\n---\n");
        assert.equal(added("---\naliases:\nx: 1\n---\n"), "---\naliases:\n  - Garden plan\nx: 1\n---\n");
    });

    it("does nothing when the alias is already there", () => {
        assert.deepEqual(addAlias("---\naliases: [garden plan]\n---\n", "Garden plan"), { status: "present" });
    });

    it("quotes a name YAML would read differently", () => {
        assert.equal(added("---\n---\n", "Plan: v2"), "---\naliases:\n  - \"Plan: v2\"\n---\n");
        assert.equal(added("---\n---\n", "1984"), "---\naliases:\n  - \"1984\"\n---\n");
        assert.equal(added("---\naliases: [a]\n---\n", "x, y"), "---\naliases: [a, \"x, y\"]\n---\n");
    });

    it("keeps CRLF", () => {
        assert.equal(added("---\r\ntitle: G\r\n---\r\nBody\r\n"), "---\r\ntitle: G\r\naliases:\r\n  - Garden plan\r\n---\r\nBody\r\n");
    });

    it("leaves invalid YAML alone", () => {
        const r = addAlias("---\ntitle: \"unclosed\n---\nBody", "Garden plan");
        assert.equal(r.status, "invalid");
    });
});

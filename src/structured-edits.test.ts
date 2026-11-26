import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseDocument } from "yaml";
import { appendToSection, EditRefused, setProperties } from "./structured-edits.js";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { EDIT_MAX_ATTEMPTS, NO_REVISIONS_MESSAGE, registerTools } from "./tools.js";
import { RevisionMismatchError, UpdateRetriesExhaustedError } from "./vault-backend.js";

const refused = (pattern: RegExp) => (err: unknown) => err instanceof EditRefused && pattern.test(err.message);

const PLAN = [
    "---",
    "# Planning fields, edited by hand",
    "title: \"Garden plan\"   # shown in lists",
    "state: open # current",
    "owner: 'Ana'",
    "tags:",
    "- garden",
    "- spring",
    "",
    "priority: 2",
    "---",
    "# Garden plan",
    "",
    "state: this line is body, not frontmatter",
    "",
].join("\n");

describe("setProperties", () => {
    it("replaces one key and leaves every other byte as it was", () => {
        const out = setProperties(PLAN, { state: "done" });
        assert.equal(out, PLAN.replace("state: open # current", "state: done # current"));
    });

    it("keeps comments, key order, quoting, a list, a blank line and the body when adding, replacing and removing", () => {
        const out = setProperties(PLAN, { priority: 3, due: "2026-04-01" }, ["owner"]);
        assert.equal(out, [
            "---",
            "# Planning fields, edited by hand",
            "title: \"Garden plan\"   # shown in lists",
            "state: open # current",
            "tags:",
            "- garden",
            "- spring",
            "",
            "priority: 3",
            "due: 2026-04-01",
            "---",
            "# Garden plan",
            "",
            "state: this line is body, not frontmatter",
            "",
        ].join("\n"));
    });

    it("writes lists as block lists, replacing a list or a scalar in place", () => {
        const out = setProperties(PLAN, { tags: ["garden", "summer"], state: ["open", "blocked"] });
        assert.equal(out, PLAN
            .replace("state: open # current", "state:\n  - open\n  - blocked # current")
            .replace("tags:\n- garden\n- spring", "tags:\n  - garden\n  - summer"));
        const list = setProperties("---\na: 1\n---\n", { aliases: ["Plan", 2, true] });
        assert.equal(list, "---\na: 1\naliases:\n  - Plan\n  - 2\n  - true\n---\n");
        assert.equal(setProperties("---\ntags:\n  - x\nb: 1\n---\n", { tags: [] }), "---\ntags: []\nb: 1\n---\n");
        assert.equal(setProperties("---\ntags:\n  - x\nb: 1\n---\n", { tags: "x" }), "---\ntags: x\nb: 1\n---\n");
    });

    it("quotes values so they read back as the same type", () => {
        const values: Record<string, string | number | boolean> = {
            a: "true", b: "null", c: "1.10", d: "2026-01-01", e: "a: b", f: "#x", g: "[[Note]]", h: "", i: "007",
            j: "two\nlines", k: 1.5, l: false, m: -3, "key: with colon": "v",
        };
        const out = setProperties("", values);
        const yaml = out.match(/^---\n([\s\S]*)\n---\n$/)![1];
        assert.equal(yaml.split("\n").length, Object.keys(values).length, "one line per property");
        assert.deepEqual(parseDocument(yaml).toJS(), values);
    });

    it("adds frontmatter to a note without one, and fills an empty one", () => {
        assert.equal(setProperties("# Garden plan\nbody\n", { state: "open" }), "---\nstate: open\n---\n# Garden plan\nbody\n");
        assert.equal(setProperties("", { state: "open" }), "---\nstate: open\n---\n");
        assert.equal(setProperties("---\n---\nbody", { state: "open" }), "---\nstate: open\n---\nbody");
        assert.equal(setProperties("---\n# only a comment\n---\n", { state: "open" }), "---\n# only a comment\nstate: open\n---\n");
    });

    it("removes keys, including the last one and the only one", () => {
        assert.equal(setProperties("---\na: 1\nb: 2\n---\nx", {}, ["b"]), "---\na: 1\n---\nx");
        assert.equal(setProperties("---\na: 1\nb:\n  - x\n  - y\nc: 3\n---\n", {}, ["b"]), "---\na: 1\nc: 3\n---\n");
        assert.equal(setProperties("---\na: 1\n---\nx", {}, ["a"]), "---\n---\nx");
        // Removing a key that isn't there changes nothing.
        assert.equal(setProperties(PLAN, {}, ["missing"]), PLAN);
    });

    it("keeps CRLF line endings", () => {
        assert.equal(setProperties("---\r\na: 1\r\n---\r\nbody\r\n", { b: ["x"] }), "---\r\na: 1\r\nb:\r\n  - x\r\n---\r\nbody\r\n");
        assert.equal(setProperties("---\r\na: 1\r\nb: 2\r\n---\r\n", {}, ["b"]), "---\r\na: 1\r\n---\r\n");
        assert.equal(setProperties("body\r\n", { a: 1 }), "---\r\na: 1\r\n---\r\nbody\r\n");
    });

    it("refuses frontmatter that isn't valid YAML, and writes nothing", () => {
        assert.throws(() => setProperties("---\nstate: [open\n---\nbody", { state: "done" }), refused(/isn't valid YAML/));
        assert.throws(() => setProperties("---\nstate: open\nstate: done\n---\n", { priority: 1 }), refused(/isn't valid YAML/));
        assert.throws(() => setProperties("---\n- a\n- b\n---\n", { state: "done" }), refused(/isn't a block of `key: value` lines/));
        assert.throws(() => setProperties("---\n{state: open}\n---\n", { state: "done" }), refused(/isn't a block/));
    });

    it("refuses a change that would break another key, such as an alias", () => {
        assert.throws(() => setProperties("---\na: &x 1\nb: *x\n---\n", {}, ["a"]), refused(/can't be changed without rewriting/));
    });

    it("refuses an empty change, a key in both set and remove, and a bad key", () => {
        assert.throws(() => setProperties(PLAN, {}, []), refused(/Nothing to change/));
        assert.throws(() => setProperties(PLAN, { state: "x" }, ["state"]), refused(/in both set and remove/));
        assert.throws(() => setProperties(PLAN, { "a\nb": "x" }), refused(/Invalid property name/));
        assert.throws(() => setProperties(PLAN, { " ": "x" }), refused(/Invalid property name/));
    });
});

const SECTIONS = [
    "# Garden plan",
    "",
    "## Log",
    "- seeds ordered",
    "### Week 1",
    "- beds dug",
    "",
    "```markdown",
    "## Next",
    "```",
    "",
    "## Next",
    "- water",
    "",
].join("\n");

describe("appendToSection", () => {
    it("appends after the section's last line, past nested subheadings and code, before the next heading of the same level", () => {
        assert.equal(appendToSection(SECTIONS, "Log", "- compost added"), SECTIONS.replace("## Next\n```\n", "## Next\n```\n- compost added\n"));
    });

    it("a heading inside fenced code is not a heading", () => {
        const out = appendToSection(SECTIONS, "Next", "- harvest");
        assert.equal(out, SECTIONS.replace("- water\n", "- water\n- harvest\n"));
        assert.throws(() => appendToSection("~~~\n## Log\n~~~\n", "Log", "- x"), refused(/Heading not found/));
        // A longer closing fence closes it; a shorter one doesn't.
        assert.throws(() => appendToSection("````\n```\n## Log\n````\n", "Log", "- x"), refused(/Heading not found/));
        assert.equal(appendToSection("```\n```\n## Log\n", "Log", "- x"), "```\n```\n## Log\n- x\n");
    });

    it("matches by exact text at any level, with or without the #s, ignoring a closing run of #", () => {
        assert.equal(appendToSection("### Log ###\n- a\n", "Log", "- b"), "### Log ###\n- a\n- b\n");
        assert.equal(appendToSection("# Log\n- a\n", "## Log", "- b"), "# Log\n- a\n- b\n");
        assert.throws(() => appendToSection("## Log book\n", "Log", "- b"), refused(/Heading not found/));
        assert.throws(() => appendToSection("## log\n", "Log", "- b"), refused(/Heading not found/));
    });

    it("uses the first matching heading", () => {
        assert.equal(appendToSection("## Log\n- a\n## Log\n- b\n", "Log", "- c"), "## Log\n- a\n- c\n## Log\n- b\n");
    });

    it("keeps the blank lines before the next heading, and consecutive appends stay consecutive", () => {
        let note = "## Log\n- a\n\n\n## Next\n";
        note = appendToSection(note, "Log", "- b");
        note = appendToSection(note, "Log", "- c");
        assert.equal(note, "## Log\n- a\n- b\n- c\n\n\n## Next\n");
        assert.equal(appendToSection("## Log\n\n## Next\n", "Log", "- a"), "## Log\n- a\n\n## Next\n");
    });

    it("at the end of the note, ends with one line break", () => {
        assert.equal(appendToSection("## Log\n- a", "Log", "- b"), "## Log\n- a\n- b\n");
        assert.equal(appendToSection("## Log", "Log", "- b"), "## Log\n- b\n");
        assert.equal(appendToSection("## Log\r\n- a\r\n", "Log", "- b"), "## Log\r\n- a\r\n- b\r\n");
    });

    it("ignores # lines in the frontmatter", () => {
        const note = "---\n# Log\nstate: open\n---\nbody\n";
        assert.throws(() => appendToSection(note, "Log", "- a"), refused(/Heading not found/));
        assert.equal(appendToSection(note, "Log", "- a", true), note + "\n## Log\n- a\n");
    });

    it("a missing heading is refused, or created at the end of the note", () => {
        assert.throws(() => appendToSection("body\n", "Log", "- a"), refused(/Heading not found: "Log"/));
        assert.equal(appendToSection("body\n", "Log", "- a", true), "body\n\n## Log\n- a\n");
        assert.equal(appendToSection("body", "Log", "- a", true), "body\n\n## Log\n- a\n");
        assert.equal(appendToSection("body\n\n", "Log", "- a", true), "body\n\n## Log\n- a\n");
        assert.equal(appendToSection("", "Log", "- a", true), "## Log\n- a\n");
        // An existing heading is used even with create_heading.
        assert.equal(appendToSection("## Log\n", "Log", "- a", true), "## Log\n- a\n");
    });

    it("refuses a line or heading with a line break, or empty", () => {
        for (const line of ["- a\n- b", "- a\r", "\n", "  "]) assert.throws(() => appendToSection("## Log\n", "Log", line), refused(/line/), JSON.stringify(line));
        assert.throws(() => appendToSection("## Log\n", "Log\nNext", "- a"), refused(/heading must be a single line/));
        assert.throws(() => appendToSection("## Log\n", "", "- a", true), refused(/heading is empty/));
    });

    it("refuses to append into a code block left open at the end", () => {
        assert.throws(() => appendToSection("## Log\n```\ncode\n", "Log", "- a"), refused(/unclosed code block/));
        assert.throws(() => appendToSection("```\ncode\n", "Log", "- a", true), refused(/unclosed code block/));
    });
});

// --- The tools ---

function captureTools(vault: any, writeFolders: string | null = null, readOnly = false) {
    const tools: any[] = [];
    const searchIndex = new SearchIndex();
    registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", readOnly, writeFolders === null ? null : parseWriteFolders(writeFolders));
    const call = (name: string, args: any): Promise<string> => {
        const tool = tools.find((t) => t.name === name);
        assert.ok(tool, `${name} registered`);
        return tool.execute(tool.parameters.parse(args), {});
    };
    return { tools, call, searchIndex };
}

/** An in-memory backend with revisions, which can let "another writer" in before each write (as in tools.test.ts). */
function revisedVault(initial: string) {
    let content = initial;
    let rev = 1;
    const interleave: ((c: string) => string)[] = [];
    return {
        get content() { return content; },
        interleave,
        readNote: async () => content,
        updateNote: async (_p: string, apply: (c: string) => string, o: any = {}) => {
            const allowed = o.expectedRevision !== undefined ? 1 : (o.maxAttempts ?? 1);
            for (let attempt = 1; attempt <= allowed; attempt++) {
                const base = `${rev}-a`;
                if (o.expectedRevision !== undefined && o.expectedRevision !== base) throw new RevisionMismatchError("a.md", o.expectedRevision, base);
                const next = apply(content);
                const other = interleave.shift();
                if (other) { content = other(content); rev++; }
                if (`${rev}-a` === base) { content = next; rev++; return { content, revision: `${rev}-a`, attempts: attempt }; }
                if (o.expectedRevision !== undefined) throw new RevisionMismatchError("a.md", o.expectedRevision, `${rev}-a`);
            }
            throw new UpdateRetriesExhaustedError("a.md", allowed);
        },
    };
}

describe("set_properties and append_to_section tools", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "structured-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    it("local mode: both change the note on disk and answer like edit_note, without a revision", async () => {
        const root = await mkdtemp(join(dir, "v-"));
        await writeFile(join(root, "plan.md"), "---\nstate: open\n---\n## Log\n- a\n");
        const { call, searchIndex } = captureTools(new LocalVault(root));
        assert.equal(await call("set_properties", { path: "plan.md", set: { state: "done" } }), "Note edited (set_properties): plan.md\n[Open in Obsidian](obsidian://open?vault=vault&file=plan)");
        assert.match(await call("append_to_section", { path: "plan.md", heading: "Log", line: "- b" }), /^Note edited \(append_to_section\): plan\.md\n\[Open in Obsidian\]/);
        assert.equal(await readFile(join(root, "plan.md"), "utf-8"), "---\nstate: done\n---\n## Log\n- a\n- b\n");
        assert.equal(searchIndex.getContent("plan.md"), "---\nstate: done\n---\n## Log\n- a\n- b\n");
        assert.equal(await call("set_properties", { path: "plan.md", set: { state: "x" }, expected_revision: "1-a" }), NO_REVISIONS_MESSAGE);
        assert.equal(await call("set_properties", { path: "missing.md", set: { state: "x" } }), "Note not found: missing.md");
        assert.equal(await call("append_to_section", { path: "missing.md", heading: "Log", line: "- x", create_heading: true }), "Note not found: missing.md");
        assert.match(await call("append_to_section", { path: "plan.md", heading: "Nope", line: "- x" }), /^Heading not found/);
        assert.equal(await readFile(join(root, "plan.md"), "utf-8"), "---\nstate: done\n---\n## Log\n- a\n- b\n");
    });

    it("WRITE_FOLDERS: both need update permission, before checking the note exists", async () => {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        await vault.writeNote("Raw/a.md", "## Log\n");
        await vault.writeNote("Notes/a.md", "## Log\n");
        const { call, tools } = captureTools(vault, "Notes:update,Raw:create");
        for (const path of ["Raw/a.md", "Raw/missing.md"]) {
            assert.equal(await call("set_properties", { path, set: { state: "x" } }), `Write access denied: Raw/ allows only create, so '${path}' can't be changed.`);
            assert.equal(await call("append_to_section", { path, heading: "Log", line: "- x" }), `Write access denied: Raw/ allows only create, so '${path}' can't be changed.`);
        }
        assert.match(await call("set_properties", { path: "Other/a.md", set: { state: "x" } }), /^Write access denied/);
        assert.match(await call("set_properties", { path: "Notes/a.md", set: { state: "x" } }), /^Note edited/);
        assert.match(await call("append_to_section", { path: "Notes/a.md", heading: "Log", line: "- x" }), /^Note edited/);
        assert.equal(await vault.readNote("Raw/a.md"), "## Log\n");
        for (const name of ["set_properties", "append_to_section"]) {
            assert.ok(tools.find((t) => t.name === name).description.endsWith("the most specific folder applies."), name);
        }
    });

    it("READ_ONLY: neither is registered; otherwise both are", () => {
        const names = captureTools({}, null, true).tools.map((t) => t.name);
        assert.ok(!names.includes("set_properties") && !names.includes("append_to_section"));
        assert.ok(names.includes("read_note"));
        const writable = captureTools({}).tools.map((t) => t.name);
        assert.ok(writable.includes("set_properties") && writable.includes("append_to_section"));
    });

    it("the schema takes text, numbers, booleans and lists of those, and nothing nested", () => {
        const tool = captureTools({}).tools.find((t) => t.name === "set_properties");
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: { a: "x", b: 1, c: true, d: ["x", 2, false] } }).success, true);
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: { a: { nested: 1 } } }).success, false);
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: { a: [["x"]] } }).success, false);
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: { a: null } }).success, false);
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: { a: Infinity } }).success, false);
        assert.equal(tool.parameters.safeParse({ path: "a.md", set: {}, expected_revision: "1-x" }).success, false);
    });

    it("CouchDB mode: answers with the revision, and a refusal writes nothing", async () => {
        const vault = revisedVault("---\nstate: open\n---\n## Log\n");
        const { call } = captureTools(vault);
        assert.match(await call("set_properties", { path: "a.md", set: { state: "done" } }), /^Note edited \(set_properties\): a\.md\nRevision: 2-a\n\[Open in Obsidian\]/);
        assert.match(await call("append_to_section", { path: "a.md", heading: "Log", line: "- a" }), /^Note edited \(append_to_section\): a\.md\nRevision: 3-a\n/);
        assert.equal(await call("append_to_section", { path: "a.md", heading: "Log", line: "- a\n- b" }), "line must be a single line (no line breaks). Nothing was changed.");
        assert.equal(vault.content, "---\nstate: done\n---\n## Log\n- a\n");
    });

    it("re-applied on the newer text: a concurrent change to another key is kept", async () => {
        const vault = revisedVault("---\nstate: open\npriority: 1\n---\nbody\n");
        vault.interleave.push((c) => c.replace("priority: 1", "priority: 2"));
        const { call } = captureTools(vault);
        assert.match(await call("set_properties", { path: "a.md", set: { state: "done" } }), /^Note edited \(set_properties\): a\.md\nRevision: 3-a\n/);
        assert.equal(vault.content, "---\nstate: done\npriority: 2\n---\nbody\n");
    });

    it("re-applied on the newer text: a concurrent append to the same section is kept", async () => {
        const vault = revisedVault("## Log\n- a\n\n## Next\n");
        vault.interleave.push((c) => c.replace("- a\n", "- a\n- other\n"));
        const { call } = captureTools(vault);
        assert.match(await call("append_to_section", { path: "a.md", heading: "Log", line: "- mine" }), /^Note edited/);
        assert.equal(vault.content, "## Log\n- a\n- other\n- mine\n\n## Next\n");
    });

    it("two create_heading calls racing give one heading with both lines", async () => {
        const vault = revisedVault("body\n");
        vault.interleave.push((c) => appendToSection(c, "Log", "- other", true));
        const { call } = captureTools(vault);
        assert.match(await call("append_to_section", { path: "a.md", heading: "Log", line: "- mine", create_heading: true }), /^Note edited/);
        assert.equal(vault.content, "body\n\n## Log\n- other\n- mine\n");
    });

    it("set_properties with a stale expected_revision writes nothing; exhaustion is reported", async () => {
        const vault = revisedVault("---\nstate: open\n---\n");
        const { call } = captureTools(vault);
        assert.equal(await call("set_properties", { path: "a.md", set: { state: "done" }, expected_revision: "9-a" }),
            "Revision mismatch: a.md is at revision 1-a, not 9-a. Nothing was written; read the note again and reapply your change.");
        for (let i = 0; i < EDIT_MAX_ATTEMPTS; i++) vault.interleave.push((c) => c + "x");
        assert.equal(await call("append_to_section", { path: "a.md", heading: "Log", line: "- a", create_heading: true }),
            `Failed to edit note: a.md kept changing during ${EDIT_MAX_ATTEMPTS} attempts. Nothing was written; try again.`);
        assert.ok(!vault.content.includes("state: done") && !vault.content.includes("## Log"));
    });
});

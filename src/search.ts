/**
 * Metadata index for vault notes.
 *
 * Tracks paths, mtimes, tags, links, and backlinks, and keeps the decrypted
 * note text in memory for `search_notes` (whole-word search over content).
 * Metadata persists to disk (encrypted if passphrase is set); the content map
 * is rebuilt from the vault at startup and is never written to disk.
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "crypto";
import { PARSER_VERSION, parseFrontmatterAndLinks } from "./parse.js";
import { isValidNotePath } from "./note-path.js";


function encrypt(text: string, passphrase: string): string {
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const tag = (cipher as any).getAuthTag() as Buffer;
    return salt.toString("hex") + ":" + iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data: string, passphrase: string): string {
    const [saltHex, ivHex, tagHex, encryptedHex] = data.split(":");
    const key = scryptSync(passphrase, Buffer.from(saltHex, "hex"), 32);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    (decipher as any).setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]).toString("utf-8");
}

/**
 * Lifecycle of the in-memory index. "building" from construction until the
 * startup rebuild finishes, "ready" afterwards, "failed" if the rebuild threw.
 * Read by list_notes and search_notes so a client can tell a partial index from a complete one.
 */
export type IndexState = "building" | "ready" | "failed";

export interface SearchQuery {
    /**
     * A note matches when ANY term matches (OR). A term matches when ALL its
     * words occur, in any order (see termWords); words match whole,
     * case-insensitively.
     */
    terms?: string[];
    folder?: string;
    /**
     * Folder prefixes left out unless `folder` lies inside one of them (see
     * parseSearchExclude). Hits there are counted in `excluded`, not returned.
     */
    exclude?: string[];
    tag?: string;
    /** Only notes with mtime >= this (ms since epoch). */
    modifiedAfter?: number;
    limit?: number;
}

export interface SearchHit {
    path: string;
    mtime: number;
    /** Distinct terms that matched in path/title or content. */
    matched: number;
    /**
     * True when a term matched on its own in the path, the frontmatter title,
     * the aliases or the `summary` / `case` properties. Name hits rank first.
     */
    nameHit: boolean;
    /** One line of context around the first content match; whitespace collapsed. Empty for a name-only hit. */
    snippet: string;
}

/** Cut a one-line snippet around `idx` (match of length `len`), whitespace collapsed. */
export function snippetAround(text: string, idx: number, len: number, context = 80): string {
    const start = Math.max(0, idx - context);
    const end = Math.min(text.length, idx + len + context);
    const body = text.slice(start, end).replace(/\s+/g, " ").trim();
    return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

/** Properties searched together with the path and title, besides `aliases`. */
export const NAME_PROPERTIES = ["summary", "case"] as const;

// Letters, combining marks and digits are word characters: a word of the
// term may not continue into one of them in the note.
const WORD = "[\\p{L}\\p{M}\\p{N}]";
const IS_WORD = new RegExp(WORD, "u");

/**
 * The words of a search term, lowercased and without duplicates. Spaces and
 * hyphens separate words, so "site-loss" and "site loss" give the same words;
 * any other character, punctuation included, is part of a word. A term made
 * only of spaces and hyphens (e.g. "---") has no words and matches nothing.
 */
export function termWords(term: string): string[] {
    return [...new Set(term.toLowerCase().split(/[\s-]+/u).filter((w) => w.length > 0))];
}

/**
 * Case-insensitive (Unicode) match of `word` as a whole word: where the word
 * starts or ends with a word character, the note may not have another word
 * character right before or after it. "ups" matches "UPS" and "ups," but not
 * "backups"; "[[welcome]]" and "projects/" match as written.
 */
function wordRegex(word: string): RegExp {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chars = Array.from(word);
    const before = IS_WORD.test(chars[0]) ? `(?<!${WORD})` : "";
    const after = IS_WORD.test(chars[chars.length - 1]) ? `(?!${WORD})` : "";
    return new RegExp(before + escaped + after, "iu");
}

/**
 * SEARCH_DEFAULT_EXCLUDE: comma-separated folder prefixes, each normalised to
 * "folder/" (backslashes as slashes, leading and trailing slashes dropped),
 * so "Archive" leaves out "Archive/old.md" but not "Archived/x.md".
 */
export function parseSearchExclude(raw: string | undefined): string[] {
    const folders = (raw ?? "")
        .split(",")
        .map((f) => f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
        .filter((f) => f.length > 0)
        .map((f) => f + "/");
    return [...new Set(folders)];
}

/** The excluded folders that apply to a search in `folder`: one that `folder` lies inside is asked for, so it is lifted. */
export function activeExcludes(exclude: string[], folder: string | undefined): string[] {
    const prefix = folder ? (folder.endsWith("/") ? folder : folder + "/") : undefined;
    return exclude.filter((ex) => !(prefix && prefix.startsWith(ex)));
}

export interface AttachmentEntry {
    size: number;
    mtime: number;
}

export class SearchIndex {
    private _state: IndexState = "building";
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();
    /** Decrypted note text, in memory only — one copy per note; word matching is case-insensitive via a regex per word. */
    private content = new Map<string, string>();
    /** Frontmatter `title:` per path, when present — searched together with the path. */
    private titles = new Map<string, string>();
    /** Frontmatter `aliases` per path, when present. */
    private aliases = new Map<string, string[]>();
    /** Frontmatter `summary` and `case` per path, when present, one per line — searched together with the path. */
    private nameProps = new Map<string, string>();
    /**
     * Hash of the text each note's tags, links, title and aliases were parsed from.
     * Persisted, so the startup rebuild skips parsing notes that haven't changed.
     */
    private hashes = new Map<string, string>();
    /** Binary attachments (path -> size and mtime). Metadata only: their bytes are never read for the index. */
    private attachments = new Map<string, AttachmentEntry>();
    private saving = false;
    private _since: string = "";
    /** When `since` last advanced from a completed catch-up or a watcher change (ms), null before the first. */
    private _lastSyncAt: number | null = null;
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
    }

    /** Load metadata from disk. */
    async loadFromDisk(): Promise<boolean> {
        if (!this.persistPath) return false;
        try {
            let raw = await readFile(this.persistPath, "utf-8");
            if (this.passphrase) {
                raw = decrypt(raw, this.passphrase);
            }
            const data = JSON.parse(raw);
            for (const [path, mtime] of Object.entries(data.mtimes ?? {})) {
                this.mtimes.set(path, mtime as number);
                this.knownPaths.add(path);
            }
            for (const [path, t] of Object.entries(data.tags ?? {})) {
                this.tags.set(path, t as string[]);
            }
            for (const [path, l] of Object.entries(data.links ?? {})) {
                const targets = l as string[];
                this.links.set(path, targets);
                for (const target of targets) {
                    const key = target.toLowerCase();
                    if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                    this.backlinks.get(key)!.add(path);
                }
            }
            // Hashes and titles from another parser version are dropped, so
            // those notes are parsed again by the startup rebuild.
            if (data.parser === PARSER_VERSION) {
                for (const [path, h] of Object.entries(data.hashes ?? {})) this.hashes.set(path, h as string);
                for (const [path, t] of Object.entries(data.titles ?? {})) this.titles.set(path, t as string);
                for (const [path, a] of Object.entries(data.aliases ?? {})) this.aliases.set(path, a as string[]);
                for (const [path, n] of Object.entries(data.nameProps ?? {})) this.nameProps.set(path, n as string);
            }
            for (const [path, v] of Object.entries(data.attachments ?? {})) {
                const [size, mtime] = v as [number, number];
                this.attachments.set(path, { size, mtime });
            }
            if (data.since) this._since = data.since;
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes, ${this.attachments.size} attachments, since: ${this._since ? "yes" : "none"}).`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save metadata to disk. Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath || this.saving) return;
        this.saving = true;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            let data = JSON.stringify({
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
                parser: PARSER_VERSION,
                hashes: Object.fromEntries(this.hashes),
                titles: Object.fromEntries(this.titles),
                aliases: Object.fromEntries(this.aliases),
                nameProps: Object.fromEntries(this.nameProps),
                attachments: Object.fromEntries([...this.attachments].map(([p, a]) => [p, [a.size, a.mtime]])),
                since: this._since,
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            const att = this.attachments.size > 0 ? `, ${this.attachments.size} attachments` : "";
            console.log(`Search index saved to disk (${this.knownPaths.size} notes${att}${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        } finally {
            this.saving = false;
        }
    }

    /**
     * Add or update a note in the index. The watcher and the pre-search
     * catch-up both write here without coordinating, so a write whose mtime is
     * not newer than the one recorded for text already held is skipped: a
     * stale copy can never replace a newer one. Mtimes loaded from disk carry
     * no text, so the startup rebuild still fills them in; when the text's
     * hash matches the one saved, the saved tags, links, title and aliases are kept
     * and the note isn't parsed again.
     */
    update(path: string, content: string, mtime?: number): void {
        if (mtime !== undefined && this.content.has(path) && mtime <= (this.mtimes.get(path) ?? -Infinity)) return;
        const hash = createHash("sha1").update(content).digest("base64");
        const unchanged = this.knownPaths.has(path) && this.hashes.get(path) === hash;
        this.knownPaths.add(path);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        // Same code path for the startup catch-up, the watcher and the
        // pre-search catch-up: whatever updates metadata also updates content.
        this.content.set(path, content);
        if (unchanged) return;

        this.clearBacklinks(path);
        this.hashes.delete(path);
        const parsed = parseFrontmatterAndLinks(content);
        if (parsed.frontmatterError) {
            console.warn(`Frontmatter of ${path} is not valid YAML, so its properties and tags are ignored: ${parsed.frontmatterError}`);
        }
        const title = parsed.frontmatter["title"];
        if (typeof title === "string" && title.trim().length > 0) {
            this.titles.set(path, title.trim());
        } else {
            this.titles.delete(path);
        }
        if (parsed.aliases.length > 0) {
            this.aliases.set(path, parsed.aliases);
        } else {
            this.aliases.delete(path);
        }
        const props = NAME_PROPERTIES.map((k) => parsed.frontmatter[k]?.trim()).filter((v) => v);
        if (props.length > 0) {
            this.nameProps.set(path, props.join("\n"));
        } else {
            this.nameProps.delete(path);
        }
        if (parsed.tags.length > 0) {
            this.tags.set(path, parsed.tags);
        } else {
            this.tags.delete(path);
        }
        if (parsed.links.length > 0) {
            this.links.set(path, parsed.links);
            for (const target of parsed.links) {
                const key = target.toLowerCase();
                if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                this.backlinks.get(key)!.add(path);
            }
        } else {
            this.links.delete(path);
        }
        // Last, so the hash only ever vouches for metadata that was stored.
        this.hashes.set(path, hash);
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.knownPaths.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.content.delete(path);
            this.titles.delete(path);
            this.aliases.delete(path);
            this.nameProps.delete(path);
            this.hashes.delete(path);
            this.clearBacklinks(path);
        }
    }

    /** Decrypted text of a note, or null if the index holds no content for it. */
    getContent(path: string): string | null {
        return this.content.get(path) ?? null;
    }

    /** Notes whose text is in memory. Below `size` means search cannot see every note. */
    get contentCount(): number {
        return this.content.size;
    }

    /**
     * Search over the name fields (path, frontmatter title, aliases, `summary`
     * and `case`) and the in-memory text. A term matches a note when each of
     * its words occurs as a whole word in the name fields or the text; it is a
     * name hit when all its words occur in the name fields. Ranked: name hits
     * first, then number of distinct terms matched, then newest first, then
     * path. `limit` defaults to 20. `excluded` counts the matching notes left
     * out by `exclude`.
     */
    search(q: SearchQuery): { hits: SearchHit[]; total: number; excluded: number } {
        const prefix = q.folder ? (q.folder.endsWith("/") ? q.folder : q.folder + "/") : undefined;
        const exclude = activeExcludes(q.exclude ?? [], q.folder);
        // One regex per distinct word, shared by every term that has it.
        const regexes = new Map<string, RegExp>();
        const terms = (q.terms ?? [])
            .map((t) => termWords(t))
            .filter((words) => words.length > 0)
            .map((words) => {
                for (const w of words) if (!regexes.has(w)) regexes.set(w, wordRegex(w));
                return words;
            });
        const hits: SearchHit[] = [];
        let excluded = 0;
        for (const [path, entry] of this.content) {
            // Mirror the ingest filter (GHSA-hfcr-mrh3-c584): the content map is
            // only fed validated paths, so this is defense in depth, not a gate.
            if (!isValidNotePath(path)) continue;
            if (prefix && !path.startsWith(prefix)) continue;
            if (q.tag && !this.getTags(path).includes(q.tag)) continue;
            const mtime = this.mtimes.get(path) ?? 0;
            if (q.modifiedAfter !== undefined && mtime < q.modifiedAfter) continue;
            const name = [path, this.titles.get(path), ...(this.aliases.get(path) ?? []), this.nameProps.get(path)]
                .filter((v) => v)
                .join("\n");
            // Each word is looked up at most once per note, in the name fields and in the text.
            const inName = new Map<string, boolean>();
            const inText = new Map<string, number>();
            const nameHas = (w: string) => {
                if (!inName.has(w)) inName.set(w, regexes.get(w)!.test(name));
                return inName.get(w)!;
            };
            const textAt = (w: string) => {
                if (!inText.has(w)) inText.set(w, entry.search(regexes.get(w)!));
                return inText.get(w)!;
            };
            let matched = 0;
            let nameHit = false;
            let anchor = -1;
            let anchorLen = 1;
            for (const words of terms) {
                if (!words.every((w) => nameHas(w) || textAt(w) !== -1)) continue;
                matched++;
                if (words.every(nameHas)) nameHit = true;
                for (const w of words) {
                    const i = textAt(w);
                    if (i !== -1 && (anchor === -1 || i < anchor)) {
                        anchor = i;
                        anchorLen = w.length;
                    }
                }
            }
            if (matched === 0) continue;
            if (exclude.some((ex) => path.startsWith(ex))) {
                excluded++;
                continue;
            }
            const snippet = anchor === -1 ? "" : snippetAround(entry, anchor, anchorLen);
            hits.push({ path, mtime, matched, nameHit, snippet });
        }
        hits.sort(
            (a, b) =>
                Number(b.nameHit) - Number(a.nameHit) ||
                b.matched - a.matched ||
                b.mtime - a.mtime ||
                a.path.localeCompare(b.path),
        );
        return { hits: hits.slice(0, q.limit ?? 20), total: hits.length, excluded };
    }

    /** Remove all backlink entries where path is the source. */
    private clearBacklinks(path: string): void {
        const oldLinks = this.links.get(path);
        if (oldLinks) {
            for (const target of oldLinks) {
                const key = target.toLowerCase();
                this.backlinks.get(key)?.delete(path);
                if (this.backlinks.get(key)?.size === 0) this.backlinks.delete(key);
            }
        }
        this.links.delete(path);
    }

    /** List all indexed paths, optionally filtered by folder prefix. */
    listPaths(folder?: string): string[] {
        return this.listWithMtime(folder).map((n) => n.path);
    }

    /** List all indexed paths with mtimes, optionally filtered by folder prefix. */
    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        const entries = [...this.knownPaths]
            .filter(isValidNotePath)
            .filter((p) => !prefix || p.startsWith(prefix))
            .map((p) => ({ path: p, mtime: this.mtimes.get(p) ?? 0 }));
        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Get mtime for a path. */
    getMtime(path: string): number {
        return this.mtimes.get(path) ?? 0;
    }

    /** Get tags for a path. */
    getTags(path: string): string[] {
        return this.tags.get(path) ?? [];
    }

    /** Get the frontmatter aliases of a path. */
    getAliases(path: string): string[] {
        return this.aliases.get(path) ?? [];
    }

    /**
     * Notes whose file name (without .md) or one of whose aliases equals the
     * file name of `path`, for a read of a path that doesn't exist. Compared
     * case-insensitively, with hyphens, underscores and runs of spaces taken
     * as one space. `path` itself is left out; at most `limit`, sorted by path.
     */
    suggestByName(path: string, limit = 5): Array<{ path: string; alias?: string }> {
        const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[\s_-]+/g, " ").trim();
        const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
        const wanted = norm(base(path));
        if (!wanted) return [];
        const found: Array<{ path: string; alias?: string }> = [];
        for (const p of this.listPaths()) {
            if (p === path) continue;
            if (norm(base(p)) === wanted) {
                found.push({ path: p });
                continue;
            }
            const alias = this.getAliases(p).find((a) => norm(a) === wanted);
            if (alias !== undefined) found.push({ path: p, alias });
        }
        return found.slice(0, limit);
    }

    /** Get outgoing links for a path. */
    getLinks(path: string): string[] {
        return this.links.get(path) ?? [];
    }

    /** Get backlinks for a path (notes that link to it). Case-insensitive, matches by full path or filename. */
    getBacklinks(path: string): string[] {
        const results = new Set<string>();
        const withMd = (path.endsWith(".md") ? path : path + ".md").toLowerCase();
        const withoutMd = (path.endsWith(".md") ? path.slice(0, -3) : path).toLowerCase();
        const nameOnly = withoutMd.includes("/") ? withoutMd.slice(withoutMd.lastIndexOf("/") + 1) : withoutMd;

        for (const target of [withMd, withoutMd, nameOnly]) {
            const sources = this.backlinks.get(target);
            if (sources) {
                for (const s of sources) results.add(s);
            }
        }
        return [...results].sort();
    }

    /** List all tags across the vault with counts. */
    listAllTags(): Array<{ tag: string; count: number }> {
        const counts = new Map<string, number>();
        for (const tags of this.tags.values()) {
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
    }

    /** Record or update an attachment's size and mtime. */
    updateAttachment(path: string, size: number, mtime: number): void {
        this.attachments.set(path, { size, mtime });
    }

    removeAttachment(path: string): void {
        this.attachments.delete(path);
    }

    /** Replace every attachment entry (local mode's startup scan). */
    replaceAttachments(entries: Iterable<{ path: string; size: number; mtime: number }>): void {
        this.attachments.clear();
        for (const e of entries) this.attachments.set(e.path, { size: e.size, mtime: e.mtime });
    }

    clearAttachments(): void {
        this.attachments.clear();
    }

    get attachmentCount(): number {
        return this.attachments.size;
    }

    /** Indexed attachments, optionally under a folder, sorted by path. */
    listAttachments(folder?: string): Array<{ path: string; size: number; mtime: number }> {
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        return [...this.attachments]
            .filter(([p]) => !prefix || p.startsWith(prefix))
            .map(([path, a]) => ({ path, size: a.size, mtime: a.mtime }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Notes that embed or link each attachment, keyed by lowercased file name.
     * Matched by name rather than full path because Obsidian resolves
     * `![[shot.png]]` by name and relative markdown links vary; an ambiguous
     * name therefore errs towards "referenced", the safe side when the answer
     * decides what to clean up. Build once and look up many.
     */
    attachmentReferenceMap(): Map<string, Set<string>> {
        const byName = new Map<string, Set<string>>();
        for (const [target, sources] of this.backlinks) {
            const name = target.slice(target.lastIndexOf("/") + 1);
            if (!byName.has(name)) byName.set(name, new Set());
            for (const s of sources) byName.get(name)!.add(s);
        }
        return byName;
    }

    /** Notes that embed or link the attachment at `path` (see attachmentReferenceMap). */
    getAttachmentReferences(path: string, refs = this.attachmentReferenceMap()): string[] {
        const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
        return [...(refs.get(name) ?? [])].sort();
    }

    /** Clear all index data (for full rebuild after DB nuke). */
    clear(): void {
        const paths = Array.from(this.knownPaths);
        for (const p of paths) this.remove(p);
        this.attachments.clear();
        this._since = "";
        this._state = "building";
    }

    get state(): IndexState {
        return this._state;
    }

    set state(value: IndexState) {
        this._state = value;
    }

    get since(): string {
        return this._since;
    }

    set since(value: string) {
        this._since = value;
    }

    get lastSyncAt(): number | null {
        return this._lastSyncAt;
    }

    set lastSyncAt(value: number | null) {
        this._lastSyncAt = value;
    }

    get size(): number {
        return this.knownPaths.size;
    }
}

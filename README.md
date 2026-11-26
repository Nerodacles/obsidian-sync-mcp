# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent access to your Obsidian vault over MCP. Run it locally against your vault files, or pair it with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and deploy to the cloud so it works even when your machine is off.

> **Example:** From your phone, ask your AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## How it works

The server connects to your vault in two ways:

- **Filesystem mode** — reads `.md` files directly from your vault folder. No database needed.
- **CouchDB mode** — reads from a CouchDB database, locally or in the cloud. Your vault syncs to CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), the community Obsidian plugin (600k+ downloads). The MCP server reads from CouchDB directly using [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — the same library that powers the plugin — for proper chunk handling and E2E encryption support.

Both modes expose the same MCP tools over HTTP, so any MCP-compatible agent can connect: Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Choose your setup

| Need it always available? | Have LiveSync? | Go to |
|---|---|---|
| Yes | Yes | [Setup A](#a-deploy-mcp-to-the-cloud) — add MCP alongside your existing CouchDB |
| Yes | No | [Setup B](#b-deploy-everything-to-the-cloud) — CouchDB + MCP + LiveSync from scratch |
| No | — | [Setup C](#c-run-on-your-machine) — filesystem or CouchDB, npx or Docker |

---

## A. Deploy MCP to the cloud

You already have LiveSync and CouchDB on an always-on server. You just need the MCP server deployed alongside it.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 2 (MCP only)
```

The script asks for your CouchDB connection details, vault name, and encryption passphrase.

**Or run the Docker image on any always-on server:**

```bash
docker run -p 8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e COUCHDB_URL=https://your-couchdb:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=yourpassword \
  -e COUCHDB_DATABASE=obsidian -e VAULT_NAME=MyVault \
  -e COUCHDB_PASSPHRASE=your-encryption-passphrase \
  -e COUCHDB_OBFUSCATE_PROPERTIES=false \
  -e MCP_AUTH_TOKEN=yourpassword \
  -e BASE_URL=https://your-server-url \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Set `COUCHDB_PASSPHRASE` if you use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings. If the vault was created with LiveSync 1.0.33+ and path obfuscation, also set `COUCHDB_ID_DERIVATION_KEY` to your LiveSync recovery code (`sls-id-v1:...`, from "Show current recovery code") so the server can resolve note paths. Unicode NFC path identity (the default for databases created with LiveSync 1.0.49+) is detected from the database automatically; a brand-new empty database gets NFC unless you set `COUCHDB_PATH_NORMALIZATION=legacy`. Set `BASE_URL` to your public URL (required for OAuth callbacks when agents connect over HTTPS).

Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `https://your-server:8787/mcp` (Docker behind HTTPS).

See [Cost](#cost-flyio) for Fly.io pricing.

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

## B. Deploy everything to the cloud

Starting fresh — no LiveSync yet. Deploy CouchDB and MCP together, then set up LiveSync in Obsidian.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 1 (CouchDB + MCP)
```

The script generates credentials, creates the database, and deploys. Save the credentials it prints.

**Or with Docker Compose on any always-on server:**

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp

cat > .env <<EOF
COUCHDB_PASSWORD=changeme
MCP_AUTH_TOKEN=changeme-too
VAULT_NAME=MyVault
EOF

docker compose up -d
```

**After deployment:**

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it with the credentials from the setup output
2. Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io). With Docker Compose the MCP port is published on `localhost:8787` only; to reach it from other machines, put an HTTPS tunnel or reverse proxy in front (see [remote access](#c-run-on-your-machine)) and set `BASE_URL` to its public URL
3. The `MCP_AUTH_TOKEN` is the password you enter when an agent connects

```
Always-on server
├── CouchDB + persistent storage
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    AI agents
```

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

### Cost (Fly.io)

Applies to both Setup A and Setup B.

| Component | Cost |
|---|---|
| CouchDB + MCP VM (shared, 512MB) | ~$3-4/month (kept alive by LiveSync) |
| MCP-only VM (shared, 256MB) | ~$0-2/month (suspends when idle) |
| 1GB persistent volume | ~$0.15/month |

As of March 2026, Fly.io [may waive charges under $5/month](https://community.fly.io/t/bill-clarification-under-5-usd-of-usage-bill-charges-are-waived/26366), which could make this effectively free with a shared IPv4. Either way, cheaper than Obsidian Sync ($4/month) and you own the data.

---

## C. Run on your machine

Run the MCP server locally. Works with filesystem mode (reads vault files directly) or CouchDB mode (if you have LiveSync). Machine must stay on for agents to reach it.

**Filesystem mode (simplest):**

```bash
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

**CouchDB mode (if you have LiveSync):**

```bash
COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
COUCHDB_PASSPHRASE=your-encryption-passphrase \
COUCHDB_OBFUSCATE_PROPERTIES=false \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

Omit `COUCHDB_PASSPHRASE` if you don't use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings. If the vault was created with LiveSync 1.0.33+ and path obfuscation, also set `COUCHDB_ID_DERIVATION_KEY` to your LiveSync recovery code (`sls-id-v1:...`) so the server can resolve note paths. Unicode NFC path identity (the default for databases created with LiveSync 1.0.49+) is detected from the database automatically; a brand-new empty database gets NFC unless you set `COUCHDB_PATH_NORMALIZATION=legacy`.

**Or with Docker:**

```bash
docker run -p 127.0.0.1:8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e VAULT_PATH=/vault -v ~/Documents/MyVault:/vault \
  -e VAULT_NAME=MyVault \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Your MCP endpoint is `http://localhost:8787/mcp`.

**Want remote access?** Add a tunnel (machine must stay on):

```bash
cloudflared tunnel --url http://localhost:8787    # free
tailscale funnel 8787                             # or Tailscale
ngrok http 8787                                   # or ngrok
```

Set `BASE_URL` to the tunnel URL when using authentication.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read a note's markdown content by path (CouchDB mode: with its revision). For a path that doesn't exist, the answer still says "Note not found" and lists up to five notes whose file name or frontmatter `aliases` match the requested file name (case-insensitive; hyphens, underscores and spaces count as the same) |
| `write_note` | Create or overwrite a note (replaces entire content); optional `expected_revision`; `create_only: true` refuses to replace an existing note |
| `edit_note` | Edit a note without rewriting it — append, prepend (after frontmatter), or replace exact text; optional `expected_revision` |
| `list_folders` | List all folders in the vault with note counts — use to discover folder names |
| `list_tags` | List all tags in the vault with counts — use to discover tags before filtering |
| `list_notes` | List notes with timestamps. Filter by folder, name, tag, or date. Sort by name or modified. |
| `query_notes` | Filter notes by frontmatter properties (`eq`, `ne`, `in`, `contains`, `exists`, `missing`, `lt`, `gt`, all AND), choose the fields shown, sort by one field, and page with a cursor. The first line always states the exact number of matches. See [Querying properties](#querying-properties). |
| `search_notes` | Search note text for terms (OR, case-insensitive whole words, see [search matching](#search-matching)); paths, frontmatter titles, aliases and the `summary` and `case` properties are searched first. Filter by folder, tag, or date. Returns paths with one context line each, never the note body, after a status line that states which CouchDB sequence the index is caught up with. |
| `delete_note` | Delete a note |
| `move_note` | Move or rename a note — works across folders, creates destination folders automatically |
| `rename_note` | Move or rename a note and rewrite the links to it in other notes; keeps the old name as an alias. Not atomic, see below |
| `get_note_metadata` | Get frontmatter, tags, outgoing links, backlinks, size, timestamps and (CouchDB mode) revision — navigate the knowledge graph |
| `list_conflicts` | CouchDB mode: list notes with more than one live version (a sync conflict), with how many other versions each has; optional folder |
| `get_conflict` | CouchDB mode: show a conflicted note's versions, each as a line diff against the one reads show, with their revisions; optional `revision` for one version's full text |
| `resolve_conflict` | CouchDB mode: keep one version as it is, or write merged text, and delete every other version; refuses if the versions changed since `get_conflict` |

### Concurrent edits (CouchDB mode)

Several agents, or several server instances on one database, can edit the same note at once without losing each other's changes:

- `read_note` and `get_note_metadata` show the note's revision (`Revision: 12-3f9c…`, CouchDB's `_rev`).
- `edit_note` applies its change to the text it read and writes only if the note is still at that revision. If another writer got there first, it reads the note again and re-applies the change: at least 10 rounds, then until 50 rounds or 3 seconds, whichever comes first (on a fast database the 50-round cap usually ends it in 1-2 seconds; time spent waiting behind this instance's other edits of the note is not counted); a `replace` checks `old_text` again each time, so two agents replacing the same text get one success and one `old_text not found`. If the note keeps changing all that time (several writers hammering one note through different instances), nothing is written and the answer says so: such an edit is refused, never silently lost.
- `write_note` replacing an existing note also writes only on the revision it just read, and if another writer got in between it retries on the same budget as `edit_note` (always safe: the new text doesn't depend on the old one). The last write still wins, as before, but it no longer leaves a hidden conflict revision next to a concurrent edit; if the note keeps changing for the whole budget, nothing is written and the answer says so. Creating a new note is not checked: two instances creating the same new note at the same moment can still leave one.
- `write_note` and `edit_note` accept an optional `expected_revision`: the write only happens if the note is still at that revision; otherwise nothing is written and the answer names the current revision. `edit_note` with `expected_revision` does not retry.

Local mode has no revisions: reads show none, and `expected_revision` is refused rather than ignored. `delete_note` and `move_note` do not check revisions yet (except a case-only rename on a case-insensitive vault, which rewrites the one note like `write_note`). Edits made in Obsidian reach CouchDB through LiveSync replication, which has no revision check; an Obsidian edit racing an agent edit is still left to LiveSync's conflict handling.

### Sync conflicts (CouchDB mode)

LiveSync replication never gets a "document changed" refusal, so when Obsidian and an agent both edit a note from the same revision, CouchDB keeps both as live revision leaves and picks one as the winner by revision id. Every read shows only the winner; the other version stays in the database until someone resolves it.

- `read_note` and `get_note_metadata` start with one extra line when the note has other live versions: `CONFLICT: 1 other live version of this note; see get_conflict.` (`2 other live versions` and so on). Agents can match on the leading `CONFLICT: `. A note without a conflict gets exactly the answer it got before.
- `list_conflicts` lists the conflicted notes. It is one Mango `_find` on `_conflicts` (paged): CouchDB checks every document in the database for it, but sends back only the conflicted ones, without note text or chunks, and each of those is then read once, metadata only. No index is created, since that would write a design document into the vault database that every LiveSync device replicates.
- `get_conflict` prints a `Leaves:` line (every live revision, the winner first), then each other version as a unified line diff against the winner (`-` winner, `+` that version, two lines of context). The diffs share a 30,000-character budget and lines are cut at 500 characters; what is cut is counted, and `get_conflict` with `revision` returns one version's full text. A version that is a LiveSync deletion, or whose text can't be read, is marked as such.
- `resolve_conflict` takes the `Leaves:` line back as `expected_leaves` and either `keep` (a revision: that version's text, unchanged) or `content` (merged text). If the live versions are not exactly those, nothing is written. Otherwise the text is written as a new revision on top of the winner (nothing is written when keeping the winner), revision-checked, and then every other version is deleted at its own revision. A version that changes between those steps is left in place and reported as still live. It needs the same `WRITE_FOLDERS` `update` permission as `edit_note`, and is not available under `READ_ONLY`.

Local mode has no revisions and so no conflicts: the three tools answer that they need CouchDB mode, and reads are unchanged. Conflicts on attachments are not listed.

### Retries without duplicates (`op_id`, opt-in)

With `OPS_DATABASE` set, `write_note`, `edit_note`, `delete_note` and `move_note` take an optional `op_id` (1-128 characters of `A-Z a-z 0-9 . _ : -`, e.g. a UUID per intended change). The first call with an id runs and its answer is stored in that database; a retry with the same id returns the stored answer without writing again, on any server instance that shares the database and after a restart. The same id with other arguments is refused. A call that was claimed but never finished (still running, or the server stopped mid-call) answers that its outcome is unknown and writes nothing: read the note, then retry with a new id. Records count for 7 days and are not deleted automatically.

### Plugins (opt-in)

Set `PLUGIN_DIR` to load extra tools at startup. Each `.js` or `.mjs` file directly in that directory, in name order, default-exports a function that receives a context:

```js
// plugins/add-task.mjs
export default function register(ctx) {
    ctx.addTool({
        name: "add_task",
        description: "Append a task to a note.",
        parameters: ctx.z.object({ path: ctx.z.string(), task: ctx.z.string() }),
        execute: async ({ path, task }) => {
            await ctx.vault.editNote(path, (text) => `${text}\n- [ ] ${task}`);
            return `Added to ${path}`;
        },
    });
}
```

`ctx.vault` offers `readNote`, `getMetadata`, `listNotes`, `writeNote` (with `createOnly`), `editNote`, `deleteNote` and `moveNote`. Its writes pass the same checks as the built-in tools — `READ_ONLY`, `WRITE_FOLDERS` with its create/update/delete permissions — use the same write path, and keep the search index current; a refused write is returned to the agent as the tool's answer. Startup fails if a plugin doesn't load, throws, or adds a tool whose name is already taken. Plugins run inside the server process with its rights: the context gives no way around the checks, but install only code you trust as much as the server.

A refused write throws a `PluginWriteError` whose `code` says why: `exists` (a create-only write found a note there), `denied` (`WRITE_FOLDERS`), `read_only`, `not_found`, `revision_mismatch`, `unsupported` or `failed`. A plugin that doesn't catch it returns its message to the agent; one that does can react, for example by trying another path on `exists`.

A tool added with `writes: true` is treated like the built-in write tools: with `OPS_DATABASE` it takes `op_id` (a retry with the same id and arguments returns the first answer without running again, on any instance), and `READ_ONLY` leaves it out. Its parameters must be a `z.object` that doesn't declare `op_id` itself. Tools without the flag take no `op_id`.

**`ctx.store` (with `OPS_DATABASE`).** A plugin that needs state shared by every server instance on the vault (a counter, a marker) gets a small key/value store, kept in the `OPS_DATABASE` database next to the `op_id` records and never synced to Obsidian. It is present only when `OPS_DATABASE` is set and the server isn't `READ_ONLY`; otherwise `ctx.store` is `undefined`, so check before using it.

```js
const cur = await ctx.store.get("counter");             // { value, revision } or null
const res = await ctx.store.put("counter", (cur?.value ?? 0) + 1, cur?.revision ?? null);
if (res.conflict) { /* someone else wrote first: res.current is what is there now (or null) */ }
```

- `get(key)` returns `{ value, revision }`, or `null` when the key has no value.
- `put(key, value, expectedRevision)` writes only if the key is still at `expectedRevision`; `null` means "only if the key has no value yet". It returns `{ revision }`, or `{ conflict: true, current }` with what is there now, so the plugin can decide again. That compare-and-swap is the only concurrency control: no locks, no transactions across keys.
- Keys are 1-128 characters of `A-Z a-z 0-9 . _ -`. Each plugin file has its own keys (stored as `plugin:<file name>:<key>`), so two plugins can't see or overwrite each other's. Values are JSON, at most 64 KiB; a value that isn't JSON (a `Date`, a `Map`) is stored as `JSON.stringify` makes it.
- A CouchDB failure other than a conflict (credentials, the database unreachable) throws; it is never reported as a conflict. There is no delete.

[`examples/new-item.mjs`](examples/new-item.mjs) uses all of this: it creates numbered notes (`<folder>/<prefix>-NNN.md`) whose numbers stay unique across instances and are never handed out twice. It reserves each number in a `ctx.store` counter by compare-and-swap before creating the note create-only, so a refused create or a crash leaves a gap, never a reused number; it is a `writes: true` tool, so retries with an `op_id` are safe; and it dates notes in `NEW_ITEM_TIMEZONE`, else `DISPLAY_TIMEZONE`, else UTC. `npm run test:new-item` runs it on two instances against a throwaway CouchDB.

### Search matching

`search_notes` takes a list of terms and returns the notes that match **any** of them, ranked by how many terms matched.

- A term matches when **all** its words occur in the note, in any order: `garden plan` finds "the plan for the garden" as well as "Garden plan".
- Words match whole and case-insensitively: `ups` finds "UPS" but not "backups", and `backup` does not find "backups".
- Spaces and hyphens separate the words of a term, so `site-loss` and `site loss` are the same term. Any other character is part of a word and matched as written, so `[[welcome]]`, `#project` and `projects/` work as before. A term made only of spaces and hyphens matches nothing.
- A word may not continue into a letter, combining mark or digit in the note where it starts or ends with one: `ups` finds "UPS," and "ups-and-downs", not "backups".
- The path, the frontmatter `title`, the `aliases` and the `summary` and `case` properties are the name fields. A term whose words all occur in them is a name hit (marked `[path/title]`), and name hits rank above notes that match only in their text.
- At most 100 distinct words across all terms; a longer query is refused rather than shortened.
- Languages written without spaces between words (Chinese, Japanese) are matched by runs of characters, so search for a whole run.

With `SEARCH_DEFAULT_EXCLUDE` set, notes in those folders are left out unless the `folder` parameter points inside one of them. The status line then says which folders were left out and how many matching notes they held, so a hit is never hidden silently.

### Renaming notes

`rename_note(from, to, update_links = true, keep_alias = true)` moves a note like `move_note` and then fixes the links that pointed at it, the way Obsidian does when you rename a file in the app:

- In every note that links to `from` (found through the backlink index, not a full scan), the wikilinks, embeds and markdown links that resolve to it are rewritten to point at `to`: `[[Garden plan]]`, `[[Garden plan|label]]`, `[[Garden plan#Heading]]`, `[[Projects/Garden plan]]`, `![[Garden plan]]`, `[[Projects/Garden plan\|label]]` in a table, and `[text](Projects/Garden%20plan.md)`. Labels, headings, block references and each link's style are kept: a name stays a name (or becomes the full path when the new name is taken), a path stays a path, relative stays relative, `.md` and %-encoding stay as written. Links inside fenced or inline code are left alone, as are short links that several notes share (they are listed).
- The old name is added to the moved note's frontmatter `aliases`, creating the property (or the frontmatter) when missing, so stale references still find it; only the added text changes in the YAML. `keep_alias=false` turns this off; nothing is added when only the folder changes.
- Permissions: `delete` at `from` and `create` at `to`, as for `move_note`, and `update` on every note whose links it rewrites. A linking note it may not update is listed as not rewritten and left as it was; the rename still happens. A note that already exists at `to` is never replaced.
- The answer has one line per rewritten, not rewritten and unchanged note, plus counts.

It is **not atomic**: the move and each rewritten note are separate writes. If the server stops halfway, or Obsidian edits a linking note at the same moment, some links may still point at the old path; the alias keeps those resolvable. Links that the backlink index doesn't key by the old path or name (a partial path such as `[[Garden/Garden plan]]` from outside the folder) are not found.

### Querying properties

`query_notes` answers questions such as "every recipe still in draft" or "ready projects by priority" from the metadata index, without reading note bodies:

```
query_notes(where=[{field: "type", op: "eq", value: "recipe"}, {field: "status", op: "eq", value: "draft"}])
query_notes(where=[{field: "status", op: "eq", value: "ready"}], sort={field: "priority"}, select=["title", "priority", "updated"])
```

```
37 notes match; showing 1-37.
- [Projects/Garden plan.md](obsidian://...) · title: Garden plan · priority: 1 · updated: 2026-03-10
```

- **Fields:** any frontmatter property, plus `path`, `folder` (the parent folder, `""` at the vault root), `tags` (frontmatter and inline tags) and `mtime`. These four win over a property of the same name. A property with an empty value counts as missing.
- **Operators:** `eq`, `ne`, `in` (the value is a list), `contains`, `exists`, `missing`, `lt`, `gt`. Conditions are combined with AND. `eq`, `ne` and `in` are exact and case-sensitive. A number as value compares numerically, so `priority eq 2` matches `priority: 2`. `contains` is case-insensitive: on a list property it means "the list has this element", on text "the text contains this substring". `lt`/`gt` compare numbers as numbers and ISO dates (`2026-03-25`, `2026-03-25T10:00`, read as UTC without a zone) as dates. Everything else is compared as text. A number is never compared with a date or with text. On a list property, `eq`, `in`, `lt` and `gt` hold when any element does, and `ne` holds when none equals. `ne` and `missing` also match notes that don't have the field.
- **Output:** `select` picks the fields shown after the path (default `title`, which is the frontmatter title or else the file name; in `where` and `sort`, `title` is only the property). Lists are joined with `, ` and values over 200 characters are cut with a `… [+N chars]` marker. `format: "json"` returns `{total, shown, start, next_cursor, index, warnings, rows}` with values never cut and `null` for a missing field.
- **Sort and paging:** sort by one field, `asc` (default) or `desc`. Notes missing the field come last either way, and ties are broken by path. `limit` defaults to 50 (at most 500). When more notes match, the first line ends with `next cursor: …`. Pass that cursor with the same `where`, `sort`, `folder` and `tag` for the next page; `select`, `limit` and `format` may change. The cursor holds the last row's sort value and path, so the next page starts right after that row even if notes were added or removed in between. The total and the position are counted again on every page. A note whose sort value changed between pages can appear twice or not at all.
- **Freshness:** in CouchDB mode the index catches up with the change feed before each query, as for `search_notes`. While the index is still being built, or if the catch-up failed, a `Note:` line right after the first line says so.

### Attachments (opt-in)

With `ATTACHMENTS_ENABLED=true`, agents can also store images, PDFs, audio and video in the vault. In CouchDB mode they are written through livesync-commonlib, chunked and encrypted the same way as a file added in Obsidian, so they sync to every device.

| Tool | Description |
|---|---|
| `create_attachment_upload` | Get a one-time upload URL for a vault path. The agent sends the raw bytes there with HTTP `PUT`, e.g. `curl -fsS -X PUT --data-binary @shot.png '<url>'`. Use this for anything but tiny files |
| `write_attachment` | Fallback for clients that cannot make HTTP requests: save a tiny file from base64 (default limit 32 KB). Every byte is a model output token, so a 32 KB file is already ~13k tokens and minutes of generation |
| `move_attachment` | Move or rename an attachment (embeds in notes are not rewritten; the response lists notes that still point at the old path) |
| `delete_attachment` | Delete an attachment |
| `get_attachment_metadata` | Size, timestamps, and the notes that embed or link it |
| `list_attachments` | List attachments with size, date and how many notes use each. Filter by folder, name or extension, sort by name, date or size, or pass `unreferenced=true` to find files no note embeds or links |

The agent then embeds the file in a note with `edit_note`, e.g. `![[Attachments/shot.png]]`.

Upload URLs are served by this server at `BASE_URL/attachments/upload/<token>`, so `BASE_URL` must be reachable by the agent. The token in the URL is the only credential for that request: 32 random bytes, valid for one upload, one path, and `ATTACHMENT_UPLOAD_TTL_SECONDS`. Path checks, `WRITE_FOLDERS` and the size limit are applied when the URL is created, and existing files are never replaced unless the agent passed `overwrite=true` (which also needs the `update` permission under `WRITE_FOLDERS`). That last rule is checked again when the file is written, in the same step as the write, so of two concurrent uploads to one new path only the first succeeds and the other gets `409`.

**Behind a reverse proxy that allowlists paths:** match the exact upload URL, `PUT` with path `^/attachments/upload/[A-Za-z0-9_-]{43}$`, not the `/attachments/upload/` prefix. The server resolves `..` and `%2e%2e` in the path after the proxy has matched it, so with a prefix rule `/attachments/upload/../../mcp` reaches `/mcp`.

Allowed extensions: `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `webp`, `flac`, `m4a`, `mp3`, `ogg`, `wav`, `3gp`, `mkv`, `mov`, `mp4`, `ogv`, `webm`, `pdf`. Text formats (`.md`, `.svg`, `.html`, `.js`, `.json`, `.canvas`, ...) and dot-folders such as `.obsidian/` are always refused. Attachments never appear in `list_notes` or `search_notes`. For `list_attachments` the server keeps their path, size and modification time in its metadata index, learned from the CouchDB change feed (from the metadata alone, so file contents are never downloaded) or, in filesystem mode, from a scan at startup and the file watcher. References are matched by file name, the way Obsidian resolves `![[shot.png]]`, from `[[wikilinks]]`, `![[embeds]]` and markdown links such as `![](Attachments/shot.png)`. Two files with the same name in different folders therefore count as referenced if either one is, which errs on the safe side when cleaning up.

Every tool response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) (`obsidian://open?vault=...&file=...`) that works on Mac and iOS.

> "Add a bullet point to my daily note." "Find my notes about the MCP server and fix the typo in the second one."

---

## Authentication

Set `MCP_AUTH_TOKEN` to a password to enable authentication:

```bash
MCP_AUTH_TOKEN=mysecretpassword npx obsidian-sync-mcp
```

The server includes a self-contained OAuth 2.1 provider. When an agent connects:

1. A browser window opens with a password page
2. Enter the `MCP_AUTH_TOKEN` password
3. The agent gets an access token and refreshes it transparently

The session is shared across all your Claude interfaces (Desktop, Web, Mobile) and persists across server restarts. You'll need to re-enter the password after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`).

For non-OAuth clients (curl, MCP Inspector, custom agents), you can also pass the token directly as `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local use or behind a private network.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Filesystem mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | CouchDB mode | — | CouchDB server URL |
| `COUCHDB_USER` | CouchDB mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | CouchDB mode | — | CouchDB password (required) |
| `COUCHDB_DATABASE` | CouchDB mode | `obsidian` | CouchDB database name. The server never creates it: if it doesn't exist, startup fails with an error |
| `COUCHDB_PASSPHRASE` | CouchDB mode | — | LiveSync E2E encryption passphrase (must match plugin setting) |
| `COUCHDB_OBFUSCATE_PROPERTIES` | CouchDB mode | `false` | Set to `true` if "Obfuscate Properties" is enabled in LiveSync (obfuscates file paths, sizes, dates in the database). For existing vaults the actual setting is auto-detected at startup; this value only decides the format for a brand-new empty database |
| `COUCHDB_ID_DERIVATION_KEY` | CouchDB mode | — | LiveSync "independent ID derivation" recovery code (`sls-id-v1:...`). Needed to read and write notes on vaults created with LiveSync 1.0.33+ that use path obfuscation; leave unset for older (passphrase-derived) vaults. Get it from LiveSync's "Show current recovery code" |
| `COUCHDB_CASE_SENSITIVE` | CouchDB mode | `false` | Set to `true` only if your LiveSync vault has "Handle filenames as case-sensitive" enabled. It must match the vault, or obfuscated document IDs won't resolve (the server fails to start with a clear message). Leave unset otherwise |
| `COUCHDB_PATH_NORMALIZATION` | CouchDB mode | `auto` | LiveSync path identity: how file names map to document IDs. `auto` follows the database, and uses `nfc` (Unicode NFC, so `Café.md` typed on macOS or Linux is the same note) for a brand-new empty database, matching LiveSync 1.0.49+. The server declares the choice in an empty database at startup, so set `legacy` before first starting it only if your LiveSync devices use legacy identity (vaults set up before 1.0.49). An explicit value that contradicts an existing database fails startup, since changing it needs a rebuild from LiveSync |
| `VAULT_NAME` | Both | `MyVault` | Vault name (used for deep links and index storage) |
| `MCP_AUTH_TOKEN` | Optional | — | Password for authentication |
| `BASE_URL` | Optional | `http://localhost:PORT` | Public URL (for OAuth callbacks when using a tunnel) |
| `PORT` | Optional | `8787` | HTTP port |
| `HOST` | Optional | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |
| `MCP_ALLOWED_HOSTS` | Optional | — | Comma-separated extra `Host` values accepted in no-auth mode (e.g. `192.168.1.5,mybox.local`). No-auth mode rejects any other Host to block browser DNS-rebinding; localhost is always allowed. Ignored when `MCP_AUTH_TOKEN` is set. |
| `DATA_DIR` | Optional | `~/.obsidian-mcp` | Directory for persisted data (metadata index, auth tokens) |
| `LOG_LEVEL` | Optional | — | Set to `debug` for verbose logging (library logs, change feed, index sync) |
| `DISPLAY_TIMEZONE` | Optional | server's zone | IANA time zone for the human-readable half of the server time in `search_notes` status lines (UTC is always printed beside it), e.g. `Europe/Berlin`. An invalid zone falls back to UTC with a warning at startup |
| `SEARCH_DEFAULT_EXCLUDE` | Optional | — | Comma-separated folders that `search_notes` leaves out by default, e.g. `Archive,Templates`. Matching is folder-boundary-aware (`Archive` leaves out `Archive/old.md`, not `Archived/x.md`). A search whose `folder` lies inside an excluded folder searches it. While set, the status line of every search says which folders were left out and how many matching notes they held. Unset or empty: every folder is searched |
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before auth session expires |
| `READ_ONLY` | Optional | `false` | Set to `true` to disable all write tools (`write_note`, `edit_note`, `delete_note`, `move_note`, `rename_note`, `resolve_conflict`). Only read tools are exposed via MCP, and the vault backend rejects writes as well. Useful when sharing the server with multiple AI clients and write access should be opt-in. This protects the vault from MCP clients; it is not a database-level guarantee. To make CouchDB itself refuse writes, use CouchDB-side controls, such as a `validate_doc_update` function that rejects the server's CouchDB user. |
| `OPS_DATABASE` | Optional | — | CouchDB mode. Name of a separate CouchDB database for `op_id` records (created at startup if missing, which needs a user allowed to create databases; otherwise create it once as admin and give the server's user access). Never the vault database. Unset: `op_id` is refused and nothing else changes. |
| `PLUGIN_DIR` | Optional | — | Directory of plugins: every `.js`/`.mjs` file in it adds tools at startup. See [Plugins](#plugins-opt-in). Unset: no plugins. |
| `WRITE_FOLDERS` | Optional | — | Comma-separated list of vault-relative folders where agents may write (e.g. `MCP,Inbox`). The whole vault stays readable; paths outside the listed folders are read-only. Add permissions after a colon to limit a folder: `create` (add new files), `update` (change existing files) and `delete` (delete files or move them away), joined with `+`. A folder without permissions gets all three. For example `MCP,Raw:create,Notes:create+update`: anything goes in `MCP`, agents can add to `Raw` but never overwrite, edit, move or delete what is there, and can add and edit in `Notes` but not delete. `move_note`, `rename_note` and `move_attachment` need `delete` at the source and `create` at the destination, and never replace an existing note; `rename_note` also needs `update` on each note whose links it rewrites. An attachment is replaced only with `overwrite=true`, which needs both `create` and `update`, so attachments can't be replaced in an `update`-only folder. The most specific folder applies, so `Raw:create,Raw/scratch` makes `Raw/scratch` fully writable; `/` stands for the vault root (`/,Raw:create` makes everything writable except `Raw`). Matching is folder-boundary-aware (`MCP` matches `MCP/note.md` but not `MCP-private/note.md`). Paths are compared the way the vault resolves them: `\` counts as `/`, and a case variant of a folder (`raw/`) gets only what both spellings allow, since LiveSync, macOS and Windows treat them as one folder. The server refuses to start on an unknown permission, a folder listed twice (case variants included) or a folder that can never match. Enforced server-side, unlike `MCP_INSTRUCTIONS`; in local mode, writes, deletes and moves through a symlink (to a file or a folder) are refused while it is set, since the check sees the requested path; reads still follow symlinks. Ignored when `READ_ONLY=true`; unset or empty means the whole vault is writable. |
| `ATTACHMENTS_ENABLED` | Optional | `false` | Set to `true` to enable the [attachment tools](#attachments-opt-in) and the upload endpoint. Under `READ_ONLY=true` only `get_attachment_metadata` and `list_attachments` are exposed and the endpoint is not mounted. With CouchDB, startup then always reads the change feed from the beginning to learn existing attachments (it already does so whenever notes are indexed, to rebuild the search text) |
| `ATTACHMENT_MAX_BYTES` | Optional | `20971520` (20 MB) | Largest file accepted by an upload URL. The whole file is held in memory while it is written |
| `ATTACHMENT_INLINE_MAX_BYTES` | Optional | `32768` (32 KB) | Largest decoded file accepted by `write_attachment`. Base64 costs about one output token per 2.5 bytes, so raising this mainly makes slow, error-prone calls possible |
| `ATTACHMENT_UPLOAD_TTL_SECONDS` | Optional | `600` | How long an upload URL stays valid |
| `ATTACHMENT_EXTENSIONS` | Optional | all supported | Comma-separated subset of the supported extensions to allow, e.g. `png,jpg,pdf`. Can only narrow the list; an unsupported extension is a startup error |
| `MCP_INSTRUCTIONS` | Optional | — | Extra text appended to the server's MCP `instructions` (the string clients inject into the system prompt). Use this to bake vault-specific conventions into the server — e.g. folder structure, naming rules, folders to avoid — so they apply across every MCP client without per-client config. Best-effort: not all clients respect `instructions`. |
| `MCP_INSTRUCTIONS_FILE` | Optional | — | Path to a file (e.g. markdown) whose contents are appended to the MCP `instructions`. Easier than `MCP_INSTRUCTIONS` for multi-line conventions. If both are set, the file wins and `MCP_INSTRUCTIONS` is ignored (with a startup warning). Missing/unreadable file or files larger than 32 KB are fatal startup errors. **Store this file somewhere only the service user can write (e.g. `chmod 600`)** — its contents land in every MCP session's system prompt, so write access to it = prompt-injection access to every client. |

Set `VAULT_PATH` for filesystem mode or `COUCHDB_URL` for CouchDB mode.

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
VAULT_PATH=~/Documents/MyVault npx obsidian-sync-mcp &
npx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect.

---

## How to update

| How you run it | How to update |
|---|---|
| `npx obsidian-sync-mcp` | Automatic — npx pulls latest |
| Fly.io | From the same directory where you ran setup: `fly deploy`. If you lost the fly.toml, run `fly config save --app your-app-name` to restore it. |
| Docker | `docker pull ghcr.io/es617/obsidian-sync-mcp:latest` and restart. The image runs as the unprivileged `node` user (uid 1000). If your data volume was created by an older image that ran as root, make it writable once: `docker run --rm -v mcp-data:/data alpine chown -R 1000:1000 /data` (for a bind mount, `chown -R 1000:1000` the host directory) |

---

## Known limitations

- **Single vault per instance.** Each server connects to one vault. For multiple vaults, run multiple instances on different ports.
- **Single machine on Fly.io.** Auth state is in-memory, so multiple machines break the OAuth flow. The setup script enforces this automatically.
- **Conflicts are resolved by an agent or in Obsidian, not automatically.** If an agent and Obsidian edit the same note at the same time, CouchDB keeps both versions and reads show one of them; the server flags such notes and `resolve_conflict` settles them ([Sync conflicts](#sync-conflicts-couchdb-mode)). Agents editing through this server (one instance or several) don't overwrite each other in CouchDB mode; see [Concurrent edits](#concurrent-edits-couchdb-mode). In CouchDB mode, concurrent `edit_note` calls through this server (one instance or several) don't overwrite each other, and `write_note` replacing an existing note doesn't leave a hidden conflict revision; creating a note, `delete_note` and `move_note` are not revision-checked.
- **`rename_note` is not atomic.** It writes the moved note and each linking note one by one, so a failure halfway leaves some links on the old path (the alias keeps them resolvable).
- **Attachments are write-and-describe only.** With `ATTACHMENTS_ENABLED=true` agents can store, move and delete media files, but the server does not return attachment contents to the model.
- **Deep links depend on the client.** Obsidian `obsidian://` deep links are included in every tool response. They work on Claude Mobile and in browsers, but some clients (Claude Desktop) may not render them as clickable links.
- **Node 22+ required.**
- **Setup script requires bash.** The `deploy/setup.sh` script works on macOS and Linux. On Windows, use WSL or Git Bash.

---

## Safety

This server gives an AI agent read/write access to your Obsidian vault.

**Agents can modify and delete notes.** Keep backups. Use tool approval deliberately.

**Authentication is optional.** Always set `MCP_AUTH_TOKEN` when exposing to the internet.

**Use HTTPS in production.** Use a tunnel or deploy behind a reverse proxy.

**Don't leave `LOG_LEVEL=debug` on in production.** Debug logging records every tool call's arguments, including note contents, and full error stacks. Credentials embedded in `COUCHDB_URL` are redacted from logs at every level.

This software is provided as-is under the [MIT license](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE). You are responsible for what agents do with your vault.

---

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install && npm run build
npm test              # unit tests
npm run test:e2e      # integration tests
npm run test:couchdb  # CouchDB harness (needs a throwaway CouchDB on localhost:5985)
npm run test:conflicts # makes real CouchDB conflicts, then lists, shows and resolves them (same CouchDB)
npm run test:smoke    # full smoke test: built server over MCP against CouchDB, all vault configurations
```

The CouchDB tests drop and recreate their own databases, so never point them at a real vault. Start a throwaway CouchDB with `docker run -d -p 5985:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3`. Set `TEST_PATH_NORMALIZATION=legacy` to run the harness on legacy path identity.

### Releasing

1. Commit the version bump to main: `package.json`, `package-lock.json`, `server.json`, and a `## <version>` section in `CHANGELOG.md`.
2. Either push a `v<version>` tag, or run the **Release** workflow (Actions → Release → Run workflow, which also works from a phone browser). The workflow checks the versions match, waits for CI on main's latest commit to pass, creates the tag and starts CI/CD on it, which publishes the GitHub release, the npm package and the Docker image.

---

## License

MIT — see [LICENSE](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [CouchDB](https://couchdb.apache.org/) — document database
- [Fly.io](https://fly.io/) — deployment platform

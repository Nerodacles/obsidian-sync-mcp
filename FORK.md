# This fork

`main` of this fork is upstream [es617/obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp) v0.14.0 (`cf33b30`) plus the features below, each merged from its own branch with a merge commit, so each one can be rebased or dropped on its own when upstream moves. Everything not listed here is upstream's.

## Features in main

| Feature | Branch merged | Upstream status |
| --- | --- | --- |
| Group commit: edits queued on one server for the same note are written together, so a busy note costs fewer revision rounds | `group-commit-pr-v014` | PR #73, open |
| Plugin API (`PLUGIN_DIR`), `ctx.store`, `PluginWriteError.code`, `writes: true` tools, example plugin `examples/new-item.mjs` | `plugin-store-v014` | issue #72 (plugins); the maintainer's design there differs, a rework is expected |
| `write_note` `create_only`, checked by CouchDB across instances | `plugin-store-v014` | not proposed yet |
| `op_id`: retried writes apply once (`OPS_DATABASE`) | `plugin-store-v014` | not proposed yet |
| `set_properties` and `append_to_section` | `note-properties-v014` | not proposed yet |
| `search_notes` matches whole words, ranks aliases/`summary`/`case` with names, `SEARCH_DEFAULT_EXCLUDE` | `search-matching-v014` | not proposed yet |
| `read_note` on a missing path suggests notes by file name or alias | `read-note-alias-suggestion-v014` | not proposed yet |
| Sync conflicts: `CONFLICT:` line on reads, `list_conflicts`, `get_conflict`, `resolve_conflict` | `conflict-surfacing-v014` | not proposed yet |
| `query_notes`: filter by frontmatter with an exact total and a keyset cursor | `query-notes-v014` | not proposed yet |
| `READ_FOLDERS`: a server-wide read scope; everything outside it reads as missing and can't be written | `read-scope-v014` | not proposed yet |
| `rename_note` (links rewritten at the revision they were read) and `delete_note` turning links to the deleted note into plain text | `rename-checked-v014` (contains `rename-note-v014` and `delete-unlink-v014`) | not proposed yet |

Authentication and write permissions are upstream's: one `MCP_AUTH_TOKEN` and the server-wide `WRITE_FOLDERS`. The read scope (`READ_FOLDERS`) is server-wide too.

## Kept on branches, not in main

| Branch | Status | What it is |
| --- | --- | --- |
| `named-tokens-v014` | kept for later | Several named bearer tokens (`MCP_TOKENS_FILE`), each with its own write permissions. Merging it needs every write path above (including plugin tools and the linker writes of `rename_note`/`delete_note`) moved to the per-call scope, plus a test per token. |
| `desk-answer-event-v014` | kept for later | `ctx.onNoteChange` from the CouchDB changes feed, `ctx.parseFrontmatter`, and the example plugin `examples/desk-answer-webhook.mjs` (signed webhook per desk answer). |

## Harnesses (need a throwaway CouchDB)

`test:concurrency`, `test:idempotency`, `test:new-item`, `test:conflicts`, `test:delete-unlink`, `test:rename-race`, `test:read-scope`, besides upstream's `test:couchdb` and `test:smoke`.

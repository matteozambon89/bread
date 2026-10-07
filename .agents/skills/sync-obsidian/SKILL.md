---
name: sync-obsidian
description: Sync bread's public docs (README.md, AGENTS.md, docs/*.md) into the user's Obsidian vault under Projects/bread/. Use when the user asks to sync, mirror, or update bread's docs in Obsidian.
---

Run `bun run sync:obsidian` from the repo root and report its summary output (files written, vault path used) to the user.

## What it does

`scripts/sync-obsidian.ts` resolves the vault path from
`~/Library/Application Support/obsidian/obsidian.json`, then copies `README.md`, `AGENTS.md`,
and every file under `docs/` into `<vault>/Projects/bread/`, adding Obsidian frontmatter
(`title`, `tags`, `source`, `synced`) and rewriting relative links between synced docs into
`[[wikilinks]]`.

## Known limitations

- **One-directional.** Every run overwrites the vault copy wholesale. Don't hand-edit synced
  notes in Obsidian — those edits are lost on the next sync.
- **Scope.** Only the public doc set above is synced. Per-package `README.md` files
  (packages/*, stores/*, etc.) stay out — ask the user before expanding scope.
- Links pointing outside the synced set (external URLs, per-package READMEs, examples/) are left
  as plain Markdown links, not rewritten.
- A vault note left at `Projects/bread/CLAUDE.md` from an older sync is not removed. Delete it
  in the vault after the first sync that writes `AGENTS.md`.

## Before the first run ever

Confirm with the user before running against the vault for the first time — this actually
writes files to their Obsidian vault, which is outside the repo.

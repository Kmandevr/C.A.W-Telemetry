---
name: code-nav
description: Find your way around the relay's code with Graphify (files, dependencies, blast radius) and Serena (JavaScript symbols, references, symbol edits) instead of reading whole files. Use before changing code you haven't seen this session, and run its self-test when either tool seems broken.
---

# Navigate code with Graphify and Serena

What each covers: "Graphify and Serena" in `.claude/README.md`.

1. **Orient (Graphify, file level).** Keywords, not sentences:
   - `.claude/tools/graph.sh query "publish reports"`: the nodes and files in an area.
   - `.claude/tools/graph.sh explain "<name>"`: one node and its neighbours (prefix the path when a name is in several files: `"src/index.js::postReport()"`).
   - `.claude/tools/graph.sh affected "<name>"`: what may break if it changes. Run it before editing a shared function such as `cleanReport` or `gh`.
   - `.claude/tools/graph.sh` alone prints the overview. The graph refreshes itself; never rebuild by hand. `data/` and `summaries/` are left out of it (`.graphifyignore`).
2. **Zoom in (Serena, symbol level).** One tool, `serena_repl` (session id from `initial_instructions`, once per session): `s.lsp.get_symbols_overview`, `s.lsp.find_symbol` with `include_body=True`, `s.lsp.find_referencing_symbols`.
3. **Edit.** Whole functions: `s.edit.replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`. Renames: `s.lsp.rename_symbol`. A few lines, docs and config: plain Edit.
4. **Check.** `affected` again if you changed a shared signature, then `npm test`.

## Known gaps

- `explain` and `affected` need an exact label. On "No node matching", run `query` with the bare name and copy the label.
- Serena's JavaScript support uses the TypeScript language server, which Serena installs on first use (it needs Node and npm).
- Serena's tools come from the MCP server in `.mcp.json`. If they're missing from the session, run the self-test, then restart the session.

## Self-test

```sh
.claude/skills/code-nav/check.sh
```

PASS/FAIL per check: both tools installed, the graph builds, answers a query, picks up a new file and drops a deleted one, Serena's config is present and its MCP server starts. Exit code 1 means a FAIL.

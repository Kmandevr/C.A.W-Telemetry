# .claude/ tooling

Taken from [C.A.W](https://github.com/Kmandevr/C.A.W)'s setup. `tools/` and `hooks/session-start.sh` are project-agnostic and kept identical to C.A.W's (refresh them from there); `skills/code-nav`, `settings.json`, `.serena/` and `.graphifyignore` are specific to this repository.

| Piece | Loads | Purpose |
| --- | --- | --- |
| `hooks/session-start.sh` | every session | Prints the branch, last commits, `.claude/handoff.md` if any, the navigation order and the repo map; installs Serena; refreshes the Graphify graph in the background. |
| `tools/tree.sh` | on call | Repo map from each file's first-line purpose (a directory's: its `.purpose`). `<dir>` expands one directory. |
| `tools/graph.sh` | on call | Single entry to [Graphify](https://github.com/Graphify-Labs/graphify) (project and file level); rebuilds only when files changed. |
| `tools/serena.sh`, `../.mcp.json` | when Serena's tools are used | Starts the [Serena](https://github.com/oraios/serena) MCP server (symbol level). Config: `../.serena/project.yml` (TypeScript language server for the JavaScript; file, shell, memory and onboarding tools off). |
| `tools/serena-hook.sh` | on Read, Grep and Serena calls; session end | Serena's `remind` (nudges toward symbol tools after a burst of reads) and `cleanup` hooks. Does nothing without Serena. |
| `skills/code-nav` | description every session, body when invoked | Using Graphify and Serena together; `check.sh` self-tests both. |
| `settings.json` | every session | Allow rules for the tools and tests, asks before force pushes and deploys, hook registration, `enabledMcpjsonServers`. |

## Graphify and Serena

| | Graphify | Serena |
| --- | --- | --- |
| Level | Project and file | Symbol |
| Use for | "What's in this repo, what calls what, what breaks if I change this?" | "Where is `cleanReport`, who calls it, show just that function, rename it everywhere" |
| Tools | `.claude/tools/graph.sh` (`query`, `explain`, `affected`; none prints the overview) | `serena_repl` (session id from `initial_instructions`) |
| Not for | Reading or editing code | Orientation, docs, data files, shell commands |

Both install through [uv](https://docs.astral.sh/uv/). The plan and decisions live in `PLAN.md`; Serena's own memory is off, so there's no second source of truth.

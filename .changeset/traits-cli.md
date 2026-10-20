---
"traits": minor
---

Add `traits check` and `traits derive` CLI subcommands so hooks, CI, and shell
scripts can use Traits without MCP. `check` exits 0 for no findings, 1 for
findings, 2 for an operational failure, and 3 when nothing was selected.
`derive` reads `derive_trait` input JSON on stdin and prints the outcome as
JSON. Running `traits` with no subcommand, or `traits mcp`, still starts the MCP
server.

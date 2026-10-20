---
"traits": minor
---

Add `traits check`, `traits derive`, and `traits ls` CLI subcommands so hooks,
CI, and shell scripts can use Traits without MCP. `check` defaults to changed
files, takes `--target`, `--include`, `--trait`, `--path`, `--model`, and
verdict thresholds, and supports `--json`, `--quiet`, and a network-free
`--dry-run` plan. It exits 0 when no finding reaches `--fail-on` (default
`fix`), 1 when one does, and 2 for an operational failure. `derive` reads
`derive_trait` input JSON on stdin, prints the outcome as JSON, and never writes
under `--dry-run`. `layerDecisionModel` may now be a function
`({ model }) => Layer` so that `--model` can choose the Jev model. Running
`traits` with no subcommand, or `traits mcp`, still starts the MCP server.

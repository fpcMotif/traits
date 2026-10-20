import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/cli"

import { clean } from "./clean.ts"
import { effectDiagnostics } from "./effect-diagnostics.ts"
import { syncRepos } from "./sync-repos.ts"

Command.make("tasks").pipe(
  Command.withSubcommands([clean, effectDiagnostics, syncRepos]),
  Command.run({ version: "~" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)

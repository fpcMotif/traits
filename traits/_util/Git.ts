import { Data, Effect, String } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitRootError extends Data.TaggedError("GitRootError") {
  override get message() {
    return "Run from inside a Git repository or worktree"
  }
}

const resolveRoot = Effect.fn("Git.resolveRoot")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner.string(command).pipe(
    Effect.map(String.trim),
    Effect.filterOrFail(String.isNonEmpty, () => new GitRootError())
  )
})

/** The current checkout root, including when running in a linked worktree. */
export const getWorktreeRoot = resolveRoot(ChildProcess.make`git rev-parse --show-toplevel`)

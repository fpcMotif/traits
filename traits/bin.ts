#!/usr/bin/env node
// traits-ignore-file effect-utilities-with-native-behavior-exceptions: Effect utilities are unavailable until this launcher installs dependencies.
// traits-ignore-file 121f5624-31b3-41d6-a63c-30c040743ef8: Native Node APIs must install project dependencies before Effect platform services are available.
// traits-ignore-file a0e777e3-a8e0-4feb-9d8b-aa6d6f9eaa91: Dependency installation must finish before Effect error-handling APIs are available.
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const candidates = [
  ["pnpm", ["pnpm-lock.yaml"]],
  ["npm", ["package-lock.json", "npm-shrinkwrap.json"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]]
] as const

const subcommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"))
if (subcommand !== "check" && subcommand !== "derive" && subcommand !== "ls") {
  const [command, args] = installCommand(process.cwd())
  process.stderr.write(`[traits] Installing dependencies in ${process.cwd()} using ${command}\n`)
  await install(command, args)
}
await import("./main.ts")

function installCommand(root: string): [string, string[]] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const declared =
    typeof manifest === "object" && manifest !== null && "packageManager" in manifest
      ? manifest.packageManager
      : undefined
  const matches = candidates.filter((candidate) => candidate[1].some((file) => existsSync(join(root, file))))
  const manager =
    typeof declared === "string" ? declared.split("@")[0] : matches.length === 1 ? matches[0]?.[0] : undefined
  if (manager === undefined || !candidates.some((candidate) => candidate[0] === manager)) {
    throw new Error("Set package.json#packageManager to pnpm, npm, yarn, or bun to select the installer")
  }
  const locked =
    candidates.find((candidate) => candidate[0] === manager)?.[1].some((file) => existsSync(join(root, file))) ?? false
  if (manager === "npm") return [manager, [locked ? "ci" : "install"]]
  if (manager === "yarn") {
    const modern =
      typeof declared === "string"
        ? !declared.startsWith("yarn@1.")
        : /^__metadata:/m.test(readFileSync(join(root, "yarn.lock"), "utf8"))
    return [manager, ["install", ...(locked ? [modern ? "--immutable" : "--frozen-lockfile"] : [])]]
  }
  return [manager, ["install", ...(locked ? ["--frozen-lockfile"] : [])]]
}

function install(command: string, args: string[]) {
  const child = spawn(command, args, {
    stdio: ["ignore", process.stderr, process.stderr]
  })
  const interrupt = () => {
    child.kill("SIGINT")
  }
  const terminate = () => {
    child.kill("SIGTERM")
  }
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  return once(child, "close")
    .then((result) => {
      if (result[0] !== 0) throw new Error(`${command} exited with ${result[1] ?? result[0]}`)
    })
    .finally(() => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
    })
}

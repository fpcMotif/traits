---
"traits": minor
---

Read grouped traits: every folder under `.agents/traits` is a read-only group
whose top-level Markdown files are traits named `group/name`, filtered by
optional `paths` globs and `when` regexes. `derive_trait` returns
`GroupedTraitReadOnly` instead of changing a grouped trait. `traits check`
accepts `--stdin --stdin-filepath <path> --kind edit|write`, and `Verdict` is
exported from the package root. Traits no longer reads `.env` files;
configuration comes from the process environment only.

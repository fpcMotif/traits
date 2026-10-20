# Changesets

Run `bun run changeset` to describe a change to the published `traits` package
and select its version bump. Commit the generated Markdown file with the change.

On pushes to `main`, the Changesets workflow opens or updates a draft version
PR. Once the version PR is merged, it publishes the package and creates a GitHub
release.

The workflow uses GitHub-hosted Ubuntu runners and the `MADHATCHER_PAT`
repository secret for checkout, version PRs, and releases. Configure npm trusted
publishing for the `traits` package with repository `crosshatch/traits` and
workflow `changesets.yml`; npm authentication uses GitHub Actions OIDC instead
of a long-lived npm token. Initial package creation may require a manual publish
before trusted publishing can be configured.

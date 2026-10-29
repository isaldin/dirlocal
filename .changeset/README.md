# Changesets

Every change that users of a package will notice gets a changeset: `pnpm changeset`, pick the packages and bump, write one line for the changelog. The three published packages share one version (`fixed` in `config.json`): the extension and the clients speak the same HTTP contract.

Release: `pnpm version-packages` (bumps versions, writes CHANGELOGs), commit, then `pnpm release` (builds and publishes to npm).

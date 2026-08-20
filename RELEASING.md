# Releasing

The version in each package's `package.json` is its release signal. On every
push to `main`, the release workflow verifies the workspace and publishes each
package version that does not already exist on npm. Packages whose versions are
already present are skipped.

Publication uses npm trusted publishing with short-lived GitHub OIDC
credentials. No npm token is stored in GitHub, and public packages receive npm
provenance automatically.

## One-time setup

The packages must exist on npm before trusted publishers can be configured. For
the initial release, create a short-lived granular npm token with read/write
access to the `@furo9` package scope and expose it to this repository as the
GitHub Actions secret `NPM_TOKEN`. The release workflow can then publish the
initial versions in dependency order.

The equivalent local bootstrap from an authenticated npm session is:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @furo9/json-api publish --access public
pnpm --filter @furo9/json-api-resource-drizzle publish --access public
```

Without `ALLOW_INITIAL_PUBLISH=true`, the publisher skips packages that do not
exist on npm rather than attempting their initial publication.

For each package on npmjs.com, configure the same trusted publisher:

- Provider: GitHub Actions
- Organization or user: `furo9`
- Repository: `json-api`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Create a GitHub environment named `npm`. Add required reviewers if publication
should require manual approval. After verifying trusted publication, npm
recommends requiring two-factor authentication and disallowing token-based
publication in each package's settings.

## Publishing a version

Update the affected package's `version` in `package.json`, then merge or push
that change to `main`. The release workflow publishes it after typechecking,
testing, and building the entire workspace.

If one package's declared dependency range must change with another package's
version, update both manifests and versions in the same change. Workspace
packages are packed and published in dependency order.

Use the workflow's manual dispatch only to retry the current versions. It does
not republish versions that already exist on npm.

The local version-aware publish process can be validated without publishing:

```sh
pnpm publish:changed:dry-run
```

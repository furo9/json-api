# JSON:API Packages

This repository is the pnpm workspace for the `@furo9` JSON:API packages.

## Packages

- [`@furo9/json-api`](packages/json-api) provides the framework-neutral
  JSON:API engine and Web API handler.
- [`@furo9/json-api-resource-drizzle`](packages/json-api-resource-drizzle)
  provides JSON:API resources backed by PostgreSQL Drizzle tables.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Package versions are the release signal. See [Releasing](RELEASING.md) for the
npm and GitHub configuration required before enabling publication.

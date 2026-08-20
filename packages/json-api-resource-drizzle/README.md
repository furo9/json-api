# @furo9/json-api-resource-drizzle

This package adapts PostgreSQL Drizzle tables to the persistence-agnostic
`@furo9/json-api` engine.

## Installation

```sh
pnpm add @furo9/json-api @furo9/json-api-resource-drizzle drizzle-orm
```

It owns Drizzle resource declarations, typed and composite IDs, row selection
and serialization, cursor queries, direct foreign-key relationships, and join
table relationships. Database access is injected with
`configureDrizzle`, which returns a resource definition function that binds a
separate adapter to each resource without importing the application schema or
database client into this library.

Relationship includes are resolved in batches. Reverse foreign keys use one
query for all source IDs, while join relationships use one join-table query and
one target-resource query for the full source batch.

Direct columns, reverse foreign keys, and join mappings currently use scalar
relationship keys. Composite resource IDs are colon-delimited and should use
components whose string values do not contain colons.

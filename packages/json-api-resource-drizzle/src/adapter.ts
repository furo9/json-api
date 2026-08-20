import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { AnyPgColumn, PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import type {
  JsonApiResourceAdapter,
  JsonApiResource,
} from "@furo9/json-api";
import {
  defineDrizzleResourceDeclaration,
  getDrizzleIdColumns,
  getDrizzleSelection,
  isDrizzleForeignKeyRelationship,
  isDrizzleJoinRelationship,
  parseDrizzleId,
  serializeDrizzleResource,
  type DrizzleRelationshipDeclaration,
  type DrizzleResourceDeclaration,
  type DrizzleResourceInput,
} from "./drizzle";

type DrizzleJsonApiDatabase = Pick<
  PgDatabase<PgQueryResultHKT, Record<string, never>>,
  "select" | "selectDistinct"
>;

export function configureDrizzle<TDatabase extends DrizzleJsonApiDatabase>(
  getDatabase: () => TDatabase,
) {
  return function defineResource<const T extends DrizzleResourceInput>(
    input: T,
  ) {
    const declaration = defineDrizzleResourceDeclaration(input);
    return {
      ...declaration,
      adapter: createDrizzleJsonApiResourceAdapter(getDatabase, declaration),
    };
  };
}

export function createDrizzleJsonApiResourceAdapter<
  TDatabase extends DrizzleJsonApiDatabase,
>(
  getDatabase: () => TDatabase,
  declaration: DrizzleResourceDeclaration,
): JsonApiResourceAdapter {
  return {
    getResource: async ({ resourceType, id, origin }) => {
      const row = await getDrizzleResourceRow(getDatabase, declaration, id);
      return row
        ? serializeDrizzleResource(resourceType, declaration, row, { origin })
        : null;
    },
    listResources: async ({
      resourceType,
      after,
      limit,
      origin,
    }) => {
      const rows = await listDrizzleResourceRows(getDatabase, declaration, {
        after,
        limit,
      });
      return serializeRows(resourceType, declaration, rows, origin);
    },
    listResourcesByIds: async ({
      resourceType,
      ids,
      origin,
    }) => {
      const rows = await listDrizzleResourceRowsByIds(
        getDatabase,
        declaration,
        ids,
      );
      return serializeRows(resourceType, declaration, rows, origin);
    },
    resolveRelationships: async ({
      resources,
      relationship,
      origin,
    }) => {
      if (isDrizzleForeignKeyRelationship(relationship)) {
        const sourceIds = parseSourceIds(relationship.foreignKey, resources);
        const rows = await listDrizzleResourceRowsByColumn(
          getDatabase,
          declaration,
          relationship.foreignKey,
          sourceIds.values,
        );
        const resolved = emptyResolution(resources);
        for (const row of rows) {
          const target = serializeDrizzleResource(
            relationship.resourceType,
            declaration,
            row,
            { origin },
          );
          for (const sourceId of
            sourceIds.idsByValue.get(String(row.__source_id)) ?? []) {
            resolved.get(sourceId)!.push(target);
          }
        }
        return resolved;
      }
      if (isDrizzleJoinRelationship(relationship)) {
        const sourceIds = parseSourceIds(relationship.join.source, resources);
        const idsBySource = await listDrizzleResourceIdsByJoin(
          getDatabase,
          relationship.join,
          sourceIds.values,
          sourceIds.idsByValue,
        );
        const targetIds = new Set<string>();
        for (const ids of idsBySource.values()) {
          for (const id of ids) targetIds.add(id);
        }
        const rows = await listDrizzleResourceRowsByIds(
          getDatabase,
          declaration,
          [...targetIds],
        );
        const serialized = serializeRows(
          relationship.resourceType,
          declaration,
          rows,
          origin,
        );
        const resolved = emptyResolution(resources);
        const sourceIdsByTarget = new Map<string, string[]>();
        for (const [sourceId, ids] of idsBySource) {
          for (const id of ids) {
            const sourceIds = sourceIdsByTarget.get(id) ?? [];
            sourceIds.push(sourceId);
            sourceIdsByTarget.set(id, sourceIds);
          }
        }
        for (const target of serialized) {
          for (const sourceId of sourceIdsByTarget.get(target.id) ?? []) {
            resolved.get(sourceId)!.push(target);
          }
        }
        return resolved;
      }
      return undefined;
    },
  };
}

function serializeRows(
  resourceType: string,
  declaration: DrizzleResourceDeclaration,
  rows: Record<string, unknown>[],
  origin: string,
): JsonApiResource[] {
  return rows.map((row) =>
    serializeDrizzleResource(resourceType, declaration, row, { origin }),
  );
}

async function getDrizzleResourceRow(
  getDatabase: () => DrizzleJsonApiDatabase,
  declaration: DrizzleResourceDeclaration,
  id: string,
) {
  const parsedId = parseDrizzleId(declaration.source.id, id);
  if (parsedId === null) return null;
  const idColumns = getDrizzleIdColumns(declaration.source.id);
  const [row] = await getDatabase()
    .select(getDrizzleSelection(declaration))
    .from(declaration.source.table)
    .where(equalId(idColumns, parsedId))
    .limit(1);
  return row ?? null;
}

function listDrizzleResourceRows(
  getDatabase: () => DrizzleJsonApiDatabase,
  declaration: DrizzleResourceDeclaration,
  options: { after: string | null; limit: number },
) {
  const cursor =
    options.after === null
      ? null
      : parseDrizzleId(declaration.source.id, options.after);
  if (options.after !== null && cursor === null) return Promise.resolve([]);
  const idColumns = getDrizzleIdColumns(declaration.source.id);
  return getDatabase()
    .select(getDrizzleSelection(declaration))
    .from(declaration.source.table)
    .where(cursor === null ? undefined : afterId(idColumns, cursor))
    .orderBy(...idColumns.map((column) => asc(column)))
    .limit(options.limit);
}

async function listDrizzleResourceRowsByIds(
  getDatabase: () => DrizzleJsonApiDatabase,
  declaration: DrizzleResourceDeclaration,
  ids: readonly string[],
) {
  const parsedIds = ids.flatMap((id) => {
    const parsed = parseDrizzleId(declaration.source.id, id);
    return parsed === null ? [] : [parsed];
  });
  if (!parsedIds.length) return [];
  const idColumns = getDrizzleIdColumns(declaration.source.id);
  return getDatabase()
    .select(getDrizzleSelection(declaration))
    .from(declaration.source.table)
    .where(
      idColumns.length === 1
        ? inArray(idColumns[0]!, parsedIds)
        : or(...parsedIds.map((id) => equalId(idColumns, id))),
    )
    .orderBy(...idColumns.map((column) => asc(column)));
}

function listDrizzleResourceRowsByColumn(
  getDatabase: () => DrizzleJsonApiDatabase,
  declaration: DrizzleResourceDeclaration,
  foreignKey: AnyPgColumn,
  values: readonly unknown[],
) {
  if (!values.length) {
    return Promise.resolve([]);
  }
  const idColumns = getDrizzleIdColumns(declaration.source.id);
  return getDatabase()
    .select({
      ...getDrizzleSelection(declaration),
      __source_id: foreignKey,
    })
    .from(declaration.source.table)
    .where(inArray(foreignKey, values))
    .orderBy(...idColumns.map((column) => asc(column)));
}

async function listDrizzleResourceIdsByJoin(
  getDatabase: () => DrizzleJsonApiDatabase,
  join: NonNullable<DrizzleRelationshipDeclaration["join"]>,
  values: readonly unknown[],
  sourceIds: ReadonlyMap<string, readonly string[]>,
) {
  const idsBySource = new Map<string, string[]>();
  for (const ids of sourceIds.values()) {
    for (const sourceId of ids) idsBySource.set(sourceId, []);
  }
  if (!values.length) return idsBySource;
  const pairs = await getDatabase()
    .selectDistinct({
      source: join.source,
      target: join.target,
    })
    .from(join.table)
    .where(inArray(join.source, values));
  for (const pair of pairs) {
    for (const sourceId of sourceIds.get(String(pair.source)) ?? []) {
      idsBySource.get(sourceId)!.push(String(pair.target));
    }
  }
  return idsBySource;
}

function parseSourceIds(
  column: AnyPgColumn,
  resources: readonly JsonApiResource[],
) {
  const idsByValue = new Map<string, string[]>();
  const valuesByKey = new Map<string, unknown>();
  for (const resource of resources) {
    const parsed = parseDrizzleId(column, resource.id);
    if (parsed !== null && !Array.isArray(parsed)) {
      const valueKey = String(parsed);
      const sourceIds = idsByValue.get(valueKey) ?? [];
      sourceIds.push(resource.id);
      idsByValue.set(valueKey, sourceIds);
      valuesByKey.set(valueKey, parsed);
    }
  }
  return { idsByValue, values: [...valuesByKey.values()] };
}

function emptyResolution(resources: readonly JsonApiResource[]) {
  return new Map(resources.map((resource) => [resource.id, [] as JsonApiResource[]]));
}

function equalId(
  columns: ReturnType<typeof getDrizzleIdColumns>,
  value: unknown,
) {
  const values = Array.isArray(value) ? value : [value];
  return and(...columns.map((column, index) => eq(column, values[index])))!;
}

function afterId(
  columns: ReturnType<typeof getDrizzleIdColumns>,
  value: unknown,
) {
  const values = Array.isArray(value) ? value : [value];
  return or(
    ...columns.map((column, index) =>
      and(
        ...columns
          .slice(0, index)
          .map((previous, previousIndex) =>
            eq(previous, values[previousIndex]),
          ),
        gt(column, values[index]),
      ),
    ),
  )!;
}

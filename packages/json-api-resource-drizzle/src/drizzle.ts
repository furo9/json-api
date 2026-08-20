import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";

import type {
  JsonApiRelationshipDeclaration,
  JsonApiResource,
  JsonApiResourceDeclaration,
} from "@furo9/json-api";

export type DrizzleSerializationContext = {
  origin: string;
};

type ComputedField = {
  columns: readonly AnyPgColumn[];
  transform: (
    values: readonly unknown[],
    context: DrizzleSerializationContext,
  ) => unknown;
};

type DrizzleField = AnyPgColumn | ComputedField;

export type DrizzleRelationshipDeclaration = JsonApiRelationshipDeclaration & {
  column?: AnyPgColumn;
  foreignKey?: AnyPgColumn;
  join?: {
    table: AnyPgTable;
    source: AnyPgColumn;
    target: AnyPgColumn;
  };
};

export type DrizzleIdDeclaration =
  | AnyPgColumn
  | readonly [AnyPgColumn, ...AnyPgColumn[]];

export type DrizzleResourceDeclaration = JsonApiResourceDeclaration & {
  relationships: Readonly<Record<string, DrizzleRelationshipDeclaration>>;
  source: {
    table: AnyPgTable;
    id: DrizzleIdDeclaration;
    attributes: Readonly<Record<string, DrizzleField>>;
  };
};

export type DrizzleResourceInput = {
  table: AnyPgTable;
  id: DrizzleIdDeclaration;
  attributes: Readonly<Record<string, DrizzleField>>;
  relationships: Readonly<Record<string, DrizzleRelationshipDeclaration>>;
  includes?: JsonApiResourceDeclaration["includes"];
  endpoints?: JsonApiResourceDeclaration["endpoints"];
};

export function defineDrizzleResourceDeclaration<
  const T extends DrizzleResourceInput,
>(input: T) {
  return {
    attributes: Object.keys(input.attributes) as (keyof T["attributes"] & string)[],
    relationships: input.relationships,
    includes: input.includes,
    endpoints: input.endpoints,
    source: {
      table: input.table,
      id: input.id,
      attributes: input.attributes,
    },
  };
}

export function drizzleComputed(
  columns: readonly AnyPgColumn[],
  transform: ComputedField["transform"],
): ComputedField {
  return { columns, transform };
}

export function getDrizzleSelection(declaration: DrizzleResourceDeclaration) {
  const selection: Record<string, AnyPgColumn> = {};
  const idColumns = getDrizzleIdColumns(declaration.source.id);
  idColumns.forEach((column, index) => {
    selection[idColumns.length === 1 ? "__id" : `__id_${index}`] = column;
  });
  for (const [name, field] of Object.entries(declaration.source.attributes)) {
    if (isComputedField(field)) {
      field.columns.forEach((column, index) => {
        selection[`__attribute_${name}_${index}`] = column;
      });
    } else {
      selection[`__attribute_${name}`] = field;
    }
  }
  for (const [name, relationship] of Object.entries(declaration.relationships)) {
    if (relationship.column) {
      selection[`__relationship_${name}`] = relationship.column;
    }
  }
  return selection;
}

export function parseDrizzleId(
  declaration: DrizzleIdDeclaration,
  value: string,
) {
  const columns = getDrizzleIdColumns(declaration);
  const parts = columns.length === 1 ? [value] : value.split(":");
  if (parts.length !== columns.length) return null;

  const parsed = columns.map((column, index) =>
    parseDrizzleColumnValue(column, parts[index]!),
  );
  if (parsed.some((part) => part === null)) return null;
  return columns.length === 1 ? parsed[0]! : parsed;
}

export function getDrizzleIdColumns(declaration: DrizzleIdDeclaration) {
  return Array.isArray(declaration) ? declaration : [declaration];
}

function parseDrizzleColumnValue(column: AnyPgColumn, value: string) {
  if (column.dataType === "number" && !/^-?\d+(?:\.\d+)?$/.test(value)) {
    return null;
  }
  if (column.dataType === "bigint" && !/^-?\d+$/.test(value)) {
    return null;
  }

  try {
    const parsed = column.mapFromDriverValue(value);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return null;
    if (parsed instanceof Date && Number.isNaN(parsed.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function serializeDrizzleResource(
  resourceType: string,
  declaration: DrizzleResourceDeclaration,
  row: Record<string, unknown>,
  context: DrizzleSerializationContext,
): JsonApiResource {
  const attributes: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(declaration.source.attributes)) {
    attributes[name] = isComputedField(field)
      ? field.transform(
          field.columns.map((_, index) => row[`__attribute_${name}_${index}`]),
          context,
        )
      : row[`__attribute_${name}`];
  }

  const relationships = Object.fromEntries(
    Object.entries(declaration.relationships).flatMap(
      ([name, relationship]) => {
        if (!relationship.column) return [];
        const id = row[`__relationship_${name}`];
        return [
          [
            name,
            {
              data:
                id === null || id === undefined
                  ? null
                  : { type: relationship.resourceType, id: String(id) },
            },
          ],
        ];
      },
    ),
  );

  return {
    type: resourceType,
    id: serializeDrizzleId(declaration, row),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(Object.keys(relationships).length ? { relationships } : {}),
  };
}

function serializeDrizzleId(
  declaration: DrizzleResourceDeclaration,
  row: Record<string, unknown>,
) {
  const columns = getDrizzleIdColumns(declaration.source.id);
  return columns
    .map((_, index) => String(row[columns.length === 1 ? "__id" : `__id_${index}`]))
    .join(":");
}

export function isDrizzleForeignKeyRelationship(
  declaration: JsonApiRelationshipDeclaration,
): declaration is DrizzleRelationshipDeclaration & { foreignKey: AnyPgColumn } {
  return "foreignKey" in declaration && declaration.foreignKey !== undefined;
}

export function isDrizzleJoinRelationship(
  declaration: JsonApiRelationshipDeclaration,
): declaration is DrizzleRelationshipDeclaration & {
  join: NonNullable<DrizzleRelationshipDeclaration["join"]>;
} {
  return "join" in declaration && declaration.join !== undefined;
}

function isComputedField(field: DrizzleField): field is ComputedField {
  return "columns" in field && "transform" in field;
}

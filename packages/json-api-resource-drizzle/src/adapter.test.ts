import { integer, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { JsonApiResource } from "@furo9/json-api";
import { createDrizzleJsonApiResourceAdapter } from "./adapter";
import {
  defineDrizzleResourceDeclaration,
  type DrizzleRelationshipDeclaration,
} from "./drizzle";

const children = pgTable("children", {
  id: integer("id").primaryKey(),
  parentId: integer("parent_id").notNull(),
});

const parentChildren = pgTable("parent_children", {
  parentId: integer("parent_id").notNull(),
  childId: integer("child_id").notNull(),
});

const childResource = defineDrizzleResourceDeclaration({
  table: children,
  id: children.id,
  attributes: {},
  relationships: {},
});

const parents: JsonApiResource[] = [
  { type: "parents", id: "1" },
  { type: "parents", id: "01" },
  { type: "parents", id: "2" },
];

describe("Drizzle JSON:API relationship batching", () => {
  it("resolves a reverse foreign key in one query", async () => {
    const relationship: DrizzleRelationshipDeclaration = {
      resourceType: "children",
      cardinality: "many",
      foreignKey: children.parentId,
    };
    const select = vi.fn(() => orderedQuery([
      { __id: 10, __source_id: 1 },
      { __id: 20, __source_id: 2 },
      { __id: 21, __source_id: 2 },
    ]));
    const adapter = createDrizzleJsonApiResourceAdapter(
      () => ({ select, selectDistinct: vi.fn() }) as never,
      childResource,
    );

    const resolved = await adapter.resolveRelationships!({
      resources: parents,
      relationship,
      origin: "https://example.com",
    });

    expect(select).toHaveBeenCalledOnce();
    expect(resolved?.get("1")?.map(({ id }) => id)).toEqual(["10"]);
    expect(resolved?.get("01")?.map(({ id }) => id)).toEqual(["10"]);
    expect(resolved?.get("2")?.map(({ id }) => id)).toEqual(["20", "21"]);
  });

  it("resolves a join relationship in two queries for the whole batch", async () => {
    const relationship: DrizzleRelationshipDeclaration = {
      resourceType: "children",
      cardinality: "many",
      join: {
        table: parentChildren,
        source: parentChildren.parentId,
        target: parentChildren.childId,
      },
    };
    const selectDistinct = vi.fn(() => whereQuery([
      { source: 1, target: 10 },
      { source: 2, target: 20 },
      { source: 2, target: 21 },
    ]));
    const select = vi.fn(() => orderedQuery([
      { __id: 10 },
      { __id: 20 },
      { __id: 21 },
    ]));
    const adapter = createDrizzleJsonApiResourceAdapter(
      () => ({ select, selectDistinct }) as never,
      childResource,
    );

    const resolved = await adapter.resolveRelationships!({
      resources: parents,
      relationship,
      origin: "https://example.com",
    });

    expect(selectDistinct).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(resolved?.get("1")?.map(({ id }) => id)).toEqual(["10"]);
    expect(resolved?.get("01")?.map(({ id }) => id)).toEqual(["10"]);
    expect(resolved?.get("2")?.map(({ id }) => id)).toEqual(["20", "21"]);
  });
});

function orderedQuery(rows: Record<string, unknown>[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  };
}

function whereQuery(rows: Record<string, unknown>[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  };
}

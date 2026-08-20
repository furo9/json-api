import { integer, pgTable, varchar } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  defineDrizzleResourceDeclaration,
  drizzleComputed,
  getDrizzleSelection,
  parseDrizzleId,
  serializeDrizzleResource,
} from "./drizzle";

const widgets = pgTable("widgets", {
  id: integer("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  ownerId: integer("owner_id").notNull(),
});

const widgetResource = defineDrizzleResourceDeclaration({
  table: widgets,
  id: widgets.id,
  attributes: {
    name: widgets.name,
    label: drizzleComputed(
      [widgets.id, widgets.name],
      ([id, name]) => `${String(id)}: ${String(name)}`,
    ),
  },
  relationships: {
    owner: {
      resourceType: "people",
      cardinality: "one",
      column: widgets.ownerId,
    },
  },
});

const widgetOwnershipResource = defineDrizzleResourceDeclaration({
  table: widgets,
  id: [widgets.ownerId, widgets.id],
  attributes: { name: widgets.name },
  relationships: {},
});

describe("Drizzle JSON:API resources", () => {
  it("derives a Drizzle selection and serializes its row", () => {
    expect(Object.keys(getDrizzleSelection(widgetResource))).toEqual([
      "__id",
      "__attribute_name",
      "__attribute_label_0",
      "__attribute_label_1",
      "__relationship_owner",
    ]);

    expect(
      serializeDrizzleResource(
        "widgets",
        widgetResource,
        {
          __id: 1,
          __attribute_name: "Cog",
          __attribute_label_0: 1,
          __attribute_label_1: "Cog",
          __relationship_owner: 2,
        },
        { origin: "https://example.com" },
      ),
    ).toEqual({
      type: "widgets",
      id: "1",
      attributes: { name: "Cog", label: "1: Cog" },
      relationships: {
        owner: { data: { type: "people", id: "2" } },
      },
    });
  });

  it("parses resource IDs using the declared Drizzle column type", () => {
    expect(parseDrizzleId(widgets.id, "42")).toBe(42);
    expect(parseDrizzleId(widgets.id, "invalid")).toBeNull();
    expect(parseDrizzleId(widgets.name, "widget-key")).toBe("widget-key");
  });

  it("serializes and parses composite resource IDs", () => {
    expect(parseDrizzleId(widgetOwnershipResource.source.id, "2:42")).toEqual([
      2, 42,
    ]);
    expect(
      parseDrizzleId(widgetOwnershipResource.source.id, "invalid:42"),
    ).toBeNull();
    expect(
      serializeDrizzleResource(
        "widget-ownerships",
        widgetOwnershipResource,
        {
          __id_0: 2,
          __id_1: 42,
          __attribute_name: "Cog",
        },
        { origin: "https://example.com" },
      ).id,
    ).toBe("2:42");
  });
});

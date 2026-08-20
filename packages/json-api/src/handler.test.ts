import { describe, expect, it, vi } from "vitest";

import type { JsonApiResourceAdapter } from "./adapter";
import type { JsonApiImplementationDeclaration } from "./core";
import { createJsonApiHandler } from "./handler";

const settings = {
  basePath: "/api",
  pagination: { defaultPageSize: 100, maximumPageSize: 100 },
  http: {
    cors: {
      allowOrigin: "*",
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET"],
    },
    cache: {
      browserCacheControl: "no-cache",
      sharedCacheControlHeader: "CDN-Cache-Control",
      sharedMaxAgeSeconds: 0,
    },
  },
} as const;

describe("JSON:API relationship includes", () => {
  it("batch-loads direct relationship identifiers with the target adapter", async () => {
    const articles = Array.from({ length: 100 }, (_, index) => ({
      type: "articles",
      id: String(index + 1),
      relationships: {
        author: { data: { type: "people", id: String((index % 10) + 1) } },
      },
    }));
    const listResourcesByIds = vi.fn(
      async ({ ids }: Parameters<JsonApiResourceAdapter["listResourcesByIds"]>[0]) =>
        ids.map((id) => ({ type: "people", id })),
    );
    const declaration = implementation(
      "author",
      "people",
      resourceAdapter({ listResources: async () => articles }),
      resourceAdapter({ listResourcesByIds }),
    );

    const response = await requestCollection(declaration, "author");

    expect(response.status).toBe(200);
    expect(listResourcesByIds).toHaveBeenCalledOnce();
    expect(listResourcesByIds.mock.calls[0]![0].ids).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    );
    expect((await response.json()).included).toHaveLength(10);
  });

  it("offers the complete source collection to the target adapter", async () => {
    const articles = Array.from({ length: 100 }, (_, index) => ({
      type: "articles",
      id: String(index + 1),
    }));
    const resolveRelationships = vi.fn(
      async ({ resources }: Parameters<
        NonNullable<JsonApiResourceAdapter["resolveRelationships"]>
      >[0]) =>
        new Map(
          resources.map((resource) => [
            resource.id,
            [{ type: "comments", id: `comment-${resource.id}` }],
          ]),
        ),
    );
    const declaration = implementation(
      "comments",
      "comments",
      resourceAdapter({ listResources: async () => articles }),
      resourceAdapter({ resolveRelationships }),
    );

    const response = await requestCollection(declaration, "comments");

    expect(response.status).toBe(200);
    expect(resolveRelationships).toHaveBeenCalledOnce();
    expect(resolveRelationships.mock.calls[0]![0].resources).toHaveLength(100);
    expect((await response.json()).included).toHaveLength(100);
  });

  it("uses each target resource adapter for a nested include", async () => {
    const articles = Array.from({ length: 100 }, (_, index) => ({
      type: "articles",
      id: String(index + 1),
      relationships: {
        author: { data: { type: "people", id: String((index % 10) + 1) } },
      },
    }));
    const listPeople = vi.fn(
      async ({ ids }: Parameters<JsonApiResourceAdapter["listResourcesByIds"]>[0]) =>
        ids.map((id) => ({
          type: "people",
          id,
          relationships: {
            organization: {
              data: { type: "organizations", id: String((Number(id) % 2) + 1) },
            },
          },
        })),
    );
    const listOrganizations = vi.fn(
      async ({ ids }: Parameters<JsonApiResourceAdapter["listResourcesByIds"]>[0]) =>
        ids.map((id) => ({ type: "organizations", id })),
    );
    const declaration: JsonApiImplementationDeclaration = {
      settings,
      resources: {
        articles: {
          attributes: [],
          relationships: {
            author: { resourceType: "people", cardinality: "one" },
          },
          includes: { collection: ["author.organization"] },
          endpoints: { collection: true },
          adapter: resourceAdapter({ listResources: async () => articles }),
        },
        people: {
          attributes: [],
          relationships: {
            organization: {
              resourceType: "organizations",
              cardinality: "one",
            },
          },
          adapter: resourceAdapter({ listResourcesByIds: listPeople }),
        },
        organizations: {
          attributes: [],
          relationships: {},
          adapter: resourceAdapter({ listResourcesByIds: listOrganizations }),
        },
      },
    };

    const response = await requestCollection(declaration, "author.organization");

    expect(response.status).toBe(200);
    expect(listPeople).toHaveBeenCalledOnce();
    expect(listPeople.mock.calls[0]![0].ids).toHaveLength(10);
    expect(listOrganizations).toHaveBeenCalledOnce();
    expect(listOrganizations.mock.calls[0]![0].ids).toHaveLength(2);
    expect((await response.json()).included).toHaveLength(12);
  });

  it("does not create dead links for adapterless resolved resources", async () => {
    const declaration: JsonApiImplementationDeclaration = {
      settings,
      resources: {
        articles: {
          attributes: [],
          relationships: {
            preview: {
              resourceType: "previews",
              cardinality: "one",
              resolve: async ({ resources }) =>
                new Map(
                  resources.map((resource) => [
                    resource.id,
                    [{ type: "previews", id: `preview-${resource.id}` }],
                  ]),
                ),
            },
          },
          includes: { collection: ["preview"] },
          endpoints: { collection: true },
          adapter: resourceAdapter({
            listResources: async () => [{ type: "articles", id: "1" }],
          }),
        },
        previews: { attributes: [], relationships: {} },
      },
    };

    const response = await requestCollection(declaration, "preview");
    expect((await response.json()).included).toEqual([
      { type: "previews", id: "preview-1" },
    ]);
  });

  it("does not mutate or discard links from adapter resources", async () => {
    const sharedResource = {
      type: "articles",
      id: "1",
      links: { alternate: "https://example.com/original" },
      relationships: {
        author: { links: { self: "https://example.com/author-linkage" } },
      },
    };
    const declaration: JsonApiImplementationDeclaration = {
      settings,
      resources: {
        articles: {
          attributes: [],
          relationships: {
            author: { resourceType: "people", cardinality: "one" },
          },
          endpoints: { collection: true },
          adapter: resourceAdapter({ listResources: async () => [sharedResource] }),
        },
        people: {
          attributes: [],
          relationships: {},
          adapter: resourceAdapter({}),
        },
      },
    };
    const { GET } = createJsonApiHandler(declaration);

    const first = await GET(
      new Request("https://first.example/api/articles"),
      ["articles"],
    );
    const second = await GET(
      new Request("https://second.example/api/articles"),
      ["articles"],
    );
    const firstResource = (await first.json()).data[0];
    const secondResource = (await second.json()).data[0];

    expect(firstResource.links).toEqual({
      alternate: "https://example.com/original",
      self: "https://first.example/api/articles/1",
    });
    expect(firstResource.relationships.author.links).toEqual({
      self: "https://example.com/author-linkage",
      related: "https://first.example/api/articles/1/author",
    });
    expect(secondResource.links.self).toBe(
      "https://second.example/api/articles/1",
    );
    expect(sharedResource).toEqual({
      type: "articles",
      id: "1",
      links: { alternate: "https://example.com/original" },
      relationships: {
        author: {
          links: { self: "https://example.com/author-linkage" },
        },
      },
    });
  });
});

function implementation(
  relationshipName: string,
  targetResourceType: string,
  sourceAdapter: JsonApiResourceAdapter,
  targetAdapter: JsonApiResourceAdapter,
): JsonApiImplementationDeclaration {
  return {
    settings,
    resources: {
      articles: {
        attributes: [],
        relationships: {
          [relationshipName]: {
            resourceType: targetResourceType,
            cardinality: "many",
          },
        },
        includes: { collection: [relationshipName] },
        endpoints: { collection: true },
        adapter: sourceAdapter,
      },
      [targetResourceType]: {
        attributes: [],
        relationships: {},
        adapter: targetAdapter,
      },
    },
  };
}

function resourceAdapter(
  overrides: Partial<JsonApiResourceAdapter>,
): JsonApiResourceAdapter {
  return {
    getResource: async () => null,
    listResources: async () => [],
    listResourcesByIds: async () => [],
    ...overrides,
  };
}

function requestCollection(
  declaration: JsonApiImplementationDeclaration,
  include: string,
) {
  const { GET } = createJsonApiHandler(declaration);
  return GET(
    new Request(`https://example.com/api/articles?include=${include}`),
    ["articles"],
  );
}

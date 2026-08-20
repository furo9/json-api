import { describe, expect, it } from "vitest";

import {
  applySparseFields,
  createCursorPage,
  createJsonApiDocument,
  JsonApiRequestError,
  paginateResources,
  parseIncludes,
  parsePage,
  parseSparseFields,
} from ".";

describe("JSON:API documents", () => {
  it("adds the JSON:API version to a document", () => {
    expect(createJsonApiDocument({ data: null })).toEqual({
      jsonapi: { version: "1.1" },
      data: null,
    });
  });
});

describe("JSON:API query parameters", () => {
  it("supports configurable page limits and builds a cursor", () => {
    const requestUrl = new URL("https://example.com/widgets?page[size]=1");
    const page = parsePage(requestUrl.searchParams, { maximumPageSize: 10 });
    const result = paginateResources(
      [
        { type: "widgets", id: "10" },
        { type: "widgets", id: "20" },
      ],
      requestUrl,
      page,
    );

    expect(result.data).toEqual([{ type: "widgets", id: "10" }]);
    expect(result.links.next).toContain("page%5Bafter%5D=10");
    expect(result.meta).toEqual({ count: 1, total: 2 });
  });

  it("builds links for an already queried database page", () => {
    const requestUrl = new URL("https://example.com/widgets?page[size]=1");
    const result = createCursorPage(
      [{ type: "widgets", id: "20" }],
      requestUrl,
      { size: 1, after: "10" },
      { hasNext: true },
    );

    expect(result.links.next).toContain("page%5Bafter%5D=20");
    expect(result.meta).toEqual({ count: 1 });
  });

  it("rejects unsupported include paths", () => {
    const params = new URLSearchParams("include=children");
    expect(() => parseIncludes(params, new Set(["owner"]))).toThrow(
      JsonApiRequestError,
    );
  });

  it("filters both attributes and relationships with sparse fields", () => {
    const params = new URLSearchParams("fields[widgets]=name,owner");
    const fields = parseSparseFields(params, {
      widgets: new Set(["name", "size", "owner"]),
    });
    const resource = applySparseFields(
      {
        type: "widgets",
        id: "1",
        attributes: { name: "Widget", size: 1 },
        relationships: {
          owner: { data: { type: "people", id: "2" } },
        },
      },
      fields,
    );

    expect(resource.attributes).toEqual({ name: "Widget" });
    expect(resource.relationships).toHaveProperty("owner");
  });
});

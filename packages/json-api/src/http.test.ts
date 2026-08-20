import { describe, expect, it } from "vitest";

import { JsonApiRequestError } from "./core";
import { jsonApiErrorResponse, jsonApiResponse } from "./http";

const settings = {
  cors: {
    allowOrigin: "*",
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "OPTIONS"],
  },
  cache: {
    browserCacheControl: "public, max-age=0, must-revalidate",
    sharedCacheControlHeader: "Test-CDN-Cache-Control",
    sharedMaxAgeSeconds: 300,
  },
} as const;

describe("public JSON:API responses", () => {
  it("uses the JSON:API media type and Vercel cache headers", async () => {
    const response = jsonApiResponse({ data: null }, settings);

    expect(response.headers.get("content-type")).toBe(
      "application/vnd.api+json",
    );
    expect(response.headers.get("test-cdn-cache-control")).toBe(
      "public, max-age=300",
    );
    await expect(response.json()).resolves.toMatchObject({
      jsonapi: { version: "1.1" },
      data: null,
    });
  });

  it("returns JSON:API error objects without caching", async () => {
    const response = jsonApiErrorResponse(
      new JsonApiRequestError(400, "invalid-page-size", "Bad size.", "page[size]"),
      settings,
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("test-cdn-cache-control")).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      errors: [{ status: "400", source: { parameter: "page[size]" } }],
    });
  });
});

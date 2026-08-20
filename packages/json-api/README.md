# @furo9/json-api

Framework-neutral JSON:API 1.1 response engine built entirely on standard Web
APIs. It provides declaration-driven collection, resource, relationship,
include, sparse-field, cursor-pagination, CORS, and cache behavior.

## Installation

```sh
pnpm add @furo9/json-api
```

## Usage

```ts
import {
  createJsonApiHandler,
  defineJsonApiImplementation,
  type JsonApiResourceAdapter,
} from "@furo9/json-api";

declare const articleAdapter: JsonApiResourceAdapter;

const declaration = defineJsonApiImplementation({
  settings: {
    basePath: "/api",
    pagination: { defaultPageSize: 25, maximumPageSize: 100 },
    http: {
      cors: {
        allowOrigin: "*",
        allowHeaders: ["Content-Type"],
        allowMethods: ["GET", "OPTIONS"],
      },
      cache: {
        browserCacheControl: "no-cache",
        sharedCacheControlHeader: "CDN-Cache-Control",
        sharedMaxAgeSeconds: 300,
      },
    },
  },
  resources: {
    articles: {
      attributes: ["title"],
      relationships: {},
      endpoints: { collection: true, resource: true },
      adapter: articleAdapter,
    },
  },
});

const { GET, OPTIONS } = createJsonApiHandler(declaration);

// Supply path segments from any router. No framework context is required.
const response = await GET(request, ["articles", "42"]);
```

`GET` accepts a standard `Request` and a `readonly string[]` path. `OPTIONS`
returns a standard `Response` and requires no arguments.

## Adapter Contract

Each loadable resource declares a `JsonApiResourceAdapter` with
`getResource`, `listResources`, and `listResourcesByIds`. An adapter may also
implement `resolveRelationships` to batch relationship loading. Adapter values
are copied before request-specific links or linkage are added, and relationship
resolution maps are keyed by source resource ID.

Custom relationship declarations can provide a `resolve` function or a
`through` path. Adapter and resolver methods are asynchronous and return plain
JSON:API resource objects.

## Runtime Compatibility

The package is ESM and uses only `Request`, `Response`, `Headers`, `URL`, and
`URLSearchParams`. It has no Node runtime, browser, database, or framework
dependency, so it can run in browsers, workers, modern Node runtimes, and
bundlers that provide the standard Web APIs.

The Drizzle resource integration is published separately as
`@furo9/json-api-resource-drizzle`. This package does not include a client
implementation.

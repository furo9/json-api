import {
  applySparseFields,
  createCursorPage,
  getJsonApiFieldsets,
  JsonApiRequestError,
  type JsonApiImplementationDeclaration,
  type JsonApiRelationshipDeclaration,
  type JsonApiResource,
  type JsonApiResourceDeclaration,
  paginateResources,
  parseIncludes,
  parsePage,
  parseSparseFields,
} from "./core";
import {
  jsonApiErrorResponse,
  jsonApiOptionsResponse,
  jsonApiResponse,
} from "./http";

type JsonApiRuntime = {
  origin: string;
  apiBaseUrl: string;
  resourceCache: Map<string, JsonApiResource>;
  relationshipCache: Map<JsonApiResource, Map<string, JsonApiResource[]>>;
  loadResource: (
    resourceType: string,
    id: string | number,
  ) => Promise<JsonApiResource | null>;
  loadResources: (
    resourceType: string,
    ids: readonly (string | number)[],
  ) => Promise<JsonApiResource[]>;
};

export function createJsonApiHandler(
  declaration: JsonApiImplementationDeclaration,
) {
  const fieldsets = getJsonApiFieldsets(declaration);
  const httpSettings = declaration.settings.http;

  async function GET(request: Request, path: readonly string[]) {
    try {
      const requestUrl = new URL(request.url);
      const apiBaseUrl = `${requestUrl.origin}${declaration.settings.basePath}`;
      const resourceType = path[0];
      const resourceDeclaration = declaration.resources[resourceType];
      if (!resourceDeclaration?.adapter) throw notFound();

      const fields = parseSparseFields(requestUrl.searchParams, fieldsets);
      const runtime = createRuntime(
        declaration,
        requestUrl.origin,
        apiBaseUrl,
      );

      if (path.length === 1) {
        if (!resourceDeclaration.endpoints?.collection) throw notFound();
        const includes = parseIncludes(
          requestUrl.searchParams,
          new Set(resourceDeclaration.includes?.collection ?? []),
        );
        const page = parseConfiguredPage(declaration, requestUrl.searchParams);
        const loaded = await resourceDeclaration.adapter.listResources({
          resourceType,
          origin: requestUrl.origin,
          after: page.after,
          limit: page.size + 1,
        });
        const hasNext = loaded.length > page.size;
        const resources = loaded.slice(0, page.size).map((resource) =>
          prepareResource(resource, resourceDeclaration, apiBaseUrl),
        );
        const included = await resolveIncludes(
          resources,
          includes,
          runtime,
          declaration,
        );
        const data = resources.map((resource) =>
          applySparseFields(resource, fields),
        );
        return jsonApiResponse(
          {
            ...createCursorPage(data, requestUrl, page, { hasNext }),
            ...(included.length
              ? {
                  included: included.map((resource) =>
                    applySparseFields(resource, fields),
                  ),
                }
              : {}),
          },
          httpSettings,
        );
      }

      if (path.length < 2 || path.length > 3) throw notFound();
      const resource = await runtime.loadResource(resourceType, path[1]);
      if (!resource) throw notFound();

      if (path.length === 2) {
        if (!resourceDeclaration.endpoints?.resource) throw notFound();
        await hydrateToOneRelationships(declaration, resource, runtime);
        const includes = parseIncludes(
          requestUrl.searchParams,
          new Set(resourceDeclaration.includes?.resource ?? []),
        );
        const included = await resolveIncludes(
          [resource],
          includes,
          runtime,
          declaration,
        );
        return jsonApiResponse(
          {
            links: { self: requestUrl.toString() },
            data: applySparseFields(resource, fields),
            ...(included.length
              ? {
                  included: included.map((includedResource) =>
                    applySparseFields(includedResource, fields),
                  ),
                }
              : {}),
          },
          httpSettings,
        );
      }

      const relationshipName = path[2];
      const relationship = resourceDeclaration.relationships[relationshipName];
      if (!relationship) throw notFound("relationship-not-found");
      const related = await resolveRelationship(
        declaration,
        resource,
        relationshipName,
        relationship,
        runtime,
      );
      if (relationship.cardinality === "one") {
        return jsonApiResponse(
          {
            links: { self: requestUrl.toString() },
            data: related[0] ? applySparseFields(related[0], fields) : null,
          },
          httpSettings,
        );
      }

      const page = parseConfiguredPage(declaration, requestUrl.searchParams);
      const paginated = paginateResources(related, requestUrl, page);
      return jsonApiResponse(
        {
          ...paginated,
          data: paginated.data.map((relatedResource) =>
            applySparseFields(relatedResource, fields),
          ),
        },
        httpSettings,
      );
    } catch (error) {
      if (error instanceof JsonApiRequestError) {
        return jsonApiErrorResponse(error, httpSettings);
      }
      console.error("Unhandled JSON:API error", error);
      return jsonApiErrorResponse(
        new JsonApiRequestError(
          500,
          "internal-error",
          "An unexpected error occurred.",
        ),
        httpSettings,
      );
    }
  }

  function OPTIONS() {
    return jsonApiOptionsResponse(httpSettings);
  }

  return { GET, OPTIONS };
}

function createRuntime(
  declaration: JsonApiImplementationDeclaration,
  origin: string,
  apiBaseUrl: string,
) {
  const resourceCache = new Map<string, JsonApiResource>();
  const runtime: JsonApiRuntime = {
    origin,
    apiBaseUrl,
    resourceCache,
    relationshipCache: new Map(),
    loadResource: async (resourceType, id) => {
      const key = `${resourceType}:${String(id)}`;
      const cached = resourceCache.get(key);
      if (cached) return cached;
      const resourceDeclaration = declaration.resources[resourceType];
      if (!resourceDeclaration?.adapter) return null;
      const loaded = await resourceDeclaration.adapter.getResource({
        resourceType,
        id: String(id),
        origin,
      });
      if (!loaded) return null;
      const resource = prepareResource(loaded, resourceDeclaration, apiBaseUrl);
      resourceCache.set(key, resource);
      return resource;
    },
    loadResources: async (resourceType, ids) => {
      const uniqueIds = [...new Set(ids.map(String))];
      const found = new Map<string, JsonApiResource>();
      const missing: string[] = [];
      for (const id of uniqueIds) {
        const cached = resourceCache.get(`${resourceType}:${id}`);
        if (cached) found.set(id, cached);
        else missing.push(id);
      }
      const resourceDeclaration = declaration.resources[resourceType];
      if (missing.length && resourceDeclaration?.adapter) {
        const resources = await resourceDeclaration.adapter.listResourcesByIds({
          resourceType,
          ids: missing,
          origin,
        });
        for (const loaded of resources) {
          const resource = prepareResource(
            loaded,
            resourceDeclaration,
            apiBaseUrl,
          );
          resourceCache.set(`${resourceType}:${resource.id}`, resource);
          found.set(resource.id, resource);
        }
      }
      return uniqueIds.flatMap((id) => {
        const resource = found.get(id);
        return resource ? [resource] : [];
      });
    },
  };
  return runtime;
}

function prepareResource(
  resource: JsonApiResource,
  declaration: JsonApiResourceDeclaration,
  apiBaseUrl: string,
) {
  const prepared = cloneResource(resource);
  if (!declaration.adapter) return prepared;
  const resourceUrl = `${apiBaseUrl}/${prepared.type}/${prepared.id}`;
  prepared.links = { ...prepared.links, self: resourceUrl };
  prepared.relationships ??= {};
  for (const name of Object.keys(declaration.relationships)) {
    const relationship = prepared.relationships[name] ?? {};
    relationship.links = {
      ...relationship.links,
      related: `${resourceUrl}/${name}`,
    };
    prepared.relationships[name] = relationship;
  }
  return prepared;
}

function cloneResource(resource: JsonApiResource): JsonApiResource {
  return {
    ...resource,
    attributes: resource.attributes ? { ...resource.attributes } : undefined,
    links: resource.links ? { ...resource.links } : undefined,
    relationships: resource.relationships
      ? Object.fromEntries(
          Object.entries(resource.relationships).map(([name, relationship]) => [
            name,
            {
              ...relationship,
              links: relationship.links ? { ...relationship.links } : undefined,
              data: Array.isArray(relationship.data)
                ? [...relationship.data]
                : relationship.data,
            },
          ]),
        )
      : undefined,
  };
}

async function hydrateToOneRelationships(
  implementation: JsonApiImplementationDeclaration,
  resource: JsonApiResource,
  runtime: JsonApiRuntime,
) {
  const declaration = implementation.resources[resource.type];
  for (const [name, relationship] of Object.entries(declaration.relationships)) {
    if (
      relationship.cardinality === "one" &&
      resource.relationships?.[name]?.data === undefined
    ) {
      await resolveRelationship(
        implementation,
        resource,
        name,
        relationship,
        runtime,
      );
    }
  }
}

async function resolveIncludes(
  primary: JsonApiResource[],
  includePaths: ReadonlySet<string>,
  runtime: JsonApiRuntime,
  declaration: JsonApiImplementationDeclaration,
) {
  const included = new Map<string, JsonApiResource>();
  const primaryKeys = new Set(primary.map(resourceKey));
  for (const includePath of includePaths) {
    let current = primary;
    for (const relationshipName of includePath.split(".")) {
      const next: JsonApiResource[] = [];
      for (const resources of groupResourcesByType(current).values()) {
        const sourceType = resources[0]?.type;
        const relationship = sourceType
          ? declaration.resources[sourceType]?.relationships[relationshipName]
          : undefined;
        if (!relationship) continue;
        const resolved = await resolveRelationships(
          declaration,
          resources,
          relationshipName,
          relationship,
          runtime,
        );
        for (const related of resolved.values()) next.push(...related);
      }
      current = uniqueResources(next);
      for (const resource of current) {
        if (!primaryKeys.has(resourceKey(resource))) {
          included.set(resourceKey(resource), resource);
        }
      }
    }
  }
  return [...included.values()];
}

async function resolveRelationship(
  implementation: JsonApiImplementationDeclaration,
  resource: JsonApiResource,
  name: string,
  declaration: JsonApiRelationshipDeclaration,
  runtime: JsonApiRuntime,
) {
  const resolved = await resolveRelationships(
    implementation,
    [resource],
    name,
    declaration,
    runtime,
  );
  return resolved.get(resourceKey(resource)) ?? [];
}

async function resolveRelationships(
  implementation: JsonApiImplementationDeclaration,
  sourceResources: readonly JsonApiResource[],
  name: string,
  declaration: JsonApiRelationshipDeclaration,
  runtime: JsonApiRuntime,
) {
  const resources = uniqueResources(sourceResources);
  const resolved = new Map<string, JsonApiResource[]>();
  const missing: JsonApiResource[] = [];
  const targetDeclaration = implementation.resources[declaration.resourceType];
  for (const resource of resources) {
    const cached = runtime.relationshipCache.get(resource)?.get(name);
    if (cached) resolved.set(resourceKey(resource), cached);
    else missing.push(resource);
  }

  let loaded = new Map<string, readonly JsonApiResource[]>();
  if (missing.length && declaration.resolve) {
    loaded = new Map(
      await declaration.resolve({
        resources: missing,
        relationshipName: name,
        origin: runtime.origin,
        apiBaseUrl: runtime.apiBaseUrl,
        loadResource: runtime.loadResource,
        loadResources: runtime.loadResources,
      }),
    );
  } else if (missing.length) {
    const adapted = await targetDeclaration?.adapter?.resolveRelationships?.({
      resources: missing,
      relationship: declaration,
      origin: runtime.origin,
    });
    if (adapted !== undefined) {
      loaded = new Map(adapted);
    } else if (declaration.through) {
      loaded = await resolveThrough(
        implementation,
        missing,
        declaration.through,
        runtime,
      );
    } else {
      loaded = await resolveLinkedResources(
        missing,
        name,
        declaration.resourceType,
        runtime,
      );
    }
  }

  for (const resource of missing) {
    const related = targetDeclaration
      ? (loaded.get(resource.id) ?? []).map((loadedResource) => {
          const cached = runtime.resourceCache.get(resourceKey(loadedResource));
          if (cached) return cached;
          const prepared = prepareResource(
            loadedResource,
            targetDeclaration,
            runtime.apiBaseUrl,
          );
          runtime.resourceCache.set(resourceKey(prepared), prepared);
          return prepared;
        })
      : [];
    setRelationshipData(resource, name, declaration, related);
    const cachedRelationships =
      runtime.relationshipCache.get(resource) ?? new Map();
    cachedRelationships.set(name, related);
    runtime.relationshipCache.set(resource, cachedRelationships);
    resolved.set(resourceKey(resource), related);
  }
  return resolved;
}

async function resolveLinkedResources(
  resources: readonly JsonApiResource[],
  relationshipName: string,
  targetResourceType: string,
  runtime: JsonApiRuntime,
) {
  const identifiersByResource = new Map(
    resources.map((resource) => {
      const data = resource.relationships?.[relationshipName]?.data;
      return [
        resource.id,
        Array.isArray(data) ? data : data ? [data] : [],
      ] as const;
    }),
  );
  const related = await runtime.loadResources(
    targetResourceType,
    [...identifiersByResource.values()].flatMap((identifiers) =>
      identifiers.map(({ id }) => id),
    ),
  );
  const relatedById = new Map(related.map((resource) => [resource.id, resource]));
  return new Map(
    resources.map((resource) => [
      resource.id,
      (identifiersByResource.get(resource.id) ?? []).flatMap(({ id }) => {
        const relatedResource = relatedById.get(id);
        return relatedResource ? [relatedResource] : [];
      }),
    ]),
  );
}

async function resolveThrough(
  implementation: JsonApiImplementationDeclaration,
  resources: readonly JsonApiResource[],
  path: string,
  runtime: JsonApiRuntime,
) {
  let currentBySource = new Map(
    resources.map((resource) => [resource.id, [resource]]),
  );
  for (const name of path.split(".")) {
    const frontier = uniqueResources([...currentBySource.values()].flat());
    const nextByResource = new Map<string, JsonApiResource[]>();
    for (const grouped of groupResourcesByType(frontier).values()) {
      const sourceType = grouped[0]?.type;
      const relationship = sourceType
        ? implementation.resources[sourceType]?.relationships[name]
        : undefined;
      if (!relationship) continue;
      const resolved = await resolveRelationships(
        implementation,
        grouped,
        name,
        relationship,
        runtime,
      );
      for (const [key, value] of resolved) nextByResource.set(key, value);
    }
    currentBySource = new Map(
      [...currentBySource].map(([sourceId, current]) => [
        sourceId,
        uniqueResources(
          current.flatMap(
            (resource) => nextByResource.get(resourceKey(resource)) ?? [],
          ),
        ),
      ]),
    );
  }
  return currentBySource;
}

function setRelationshipData(
  resource: JsonApiResource,
  name: string,
  declaration: JsonApiRelationshipDeclaration,
  related: readonly JsonApiResource[],
) {
  resource.relationships ??= {};
  resource.relationships[name] ??= {};
  resource.relationships[name].data =
    declaration.cardinality === "one"
      ? related[0]
        ? { type: related[0].type, id: related[0].id }
        : null
      : related.map(({ type, id }) => ({ type, id }));
}

function groupResourcesByType(resources: readonly JsonApiResource[]) {
  const grouped = new Map<string, JsonApiResource[]>();
  for (const resource of resources) {
    const values = grouped.get(resource.type) ?? [];
    values.push(resource);
    grouped.set(resource.type, values);
  }
  return grouped;
}

function uniqueResources(resources: readonly JsonApiResource[]) {
  return [
    ...new Map(
      resources.map((resource) => [resourceKey(resource), resource]),
    ).values(),
  ];
}

function parseConfiguredPage(
  declaration: JsonApiImplementationDeclaration,
  searchParams: URLSearchParams,
) {
  return parsePage(searchParams, {
    defaultPageSize: declaration.settings.pagination.defaultPageSize,
    maximumPageSize: declaration.settings.pagination.maximumPageSize,
  });
}

function resourceKey(resource: JsonApiResource) {
  return `${resource.type}:${resource.id}`;
}

function notFound(code = "resource-not-found") {
  return new JsonApiRequestError(
    404,
    code,
    "The requested resource was not found.",
  );
}

import type { JsonApiResourceAdapter } from "./adapter";

export type JsonApiMeta = Record<string, unknown>;

export type JsonApiLink =
  | string
  | {
      href: string;
      meta?: JsonApiMeta;
    };

export type JsonApiLinks = Record<string, JsonApiLink | undefined>;

export type JsonApiResourceIdentifier = {
  type: string;
  id: string;
  meta?: JsonApiMeta;
};

export type JsonApiRelationship = {
  links?: JsonApiLinks;
  data?:
    | JsonApiResourceIdentifier
    | JsonApiResourceIdentifier[]
    | null;
  meta?: JsonApiMeta;
};

export type JsonApiResource = JsonApiResourceIdentifier & {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, JsonApiRelationship>;
  links?: JsonApiLinks;
};

/**
 * Related resources grouped by source ID. Missing source IDs mean no related
 * resources; values retain adapter-provided order.
 */
export type JsonApiRelationshipResolution = ReadonlyMap<
  string,
  readonly JsonApiResource[]
>;

export type JsonApiPage = {
  size: number;
  after: string | null;
};

export type JsonApiQueryOptions = {
  defaultPageSize?: number;
  maximumPageSize?: number;
};

export type JsonApiRelationshipDeclaration = {
  resourceType: string;
  cardinality: "one" | "many";
  through?: string;
  resolve?: JsonApiRelationshipResolver;
};

export type JsonApiResourceDeclaration = {
  attributes: readonly string[];
  relationships: Readonly<Record<string, JsonApiRelationshipDeclaration>>;
  adapter?: JsonApiResourceAdapter;
  includes?: {
    collection?: readonly string[];
    resource?: readonly string[];
  };
  endpoints?: {
    collection?: boolean;
    resource?: boolean;
  };
};

export type JsonApiResolverContext = {
  resources: readonly JsonApiResource[];
  relationshipName: string;
  origin: string;
  apiBaseUrl: string;
  loadResource: (
    resourceType: string,
    id: string | number,
  ) => Promise<JsonApiResource | null>;
  loadResources: (
    resourceType: string,
    ids: readonly (string | number)[],
  ) => Promise<JsonApiResource[]>;
};

export type JsonApiRelationshipResolver = (
  context: JsonApiResolverContext,
) => Promise<JsonApiRelationshipResolution>;

export type JsonApiSettings = {
  basePath: string;
  pagination: {
    defaultPageSize: number;
    maximumPageSize: number;
  };
  http: {
    cors: {
      allowOrigin: string;
      allowHeaders: readonly string[];
      allowMethods: readonly string[];
    };
    cache: {
      browserCacheControl: string;
      sharedCacheControlHeader: string;
      sharedMaxAgeSeconds: number;
    };
  };
};

export type JsonApiImplementationDeclaration = {
  settings: JsonApiSettings;
  resources: Readonly<Record<string, JsonApiResourceDeclaration>>;
};

export class JsonApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly parameter?: string,
  ) {
    super(message);
    this.name = "JsonApiRequestError";
  }
}

export function defineJsonApiImplementation<
  const T extends JsonApiImplementationDeclaration,
>(declaration: T) {
  return declaration;
}

export function getJsonApiFieldsets(
  declaration: JsonApiImplementationDeclaration,
) {
  return Object.fromEntries(
    Object.entries(declaration.resources).map(([type, resource]) => [
      type,
      new Set([
        ...resource.attributes,
        ...Object.keys(resource.relationships),
      ]),
    ]),
  );
}

export function createJsonApiDocument<T extends Record<string, unknown>>(
  document: T,
) {
  return { jsonapi: { version: "1.1" as const }, ...document };
}

export function createJsonApiErrorDocument(error: JsonApiRequestError) {
  return createJsonApiDocument({
    errors: [
      {
        status: String(error.status),
        code: error.code,
        title: errorTitle(error.status),
        detail: error.message,
        ...(error.parameter
          ? { source: { parameter: error.parameter } }
          : {}),
      },
    ],
  });
}

export function parsePage(
  searchParams: URLSearchParams,
  options: JsonApiQueryOptions = {},
): JsonApiPage {
  const defaultPageSize = options.defaultPageSize ?? 25;
  const maximumPageSize = options.maximumPageSize ?? 100;
  const sizeValue = searchParams.get("page[size]");
  const size = sizeValue === null ? defaultPageSize : Number(sizeValue);
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumPageSize) {
    throw new JsonApiRequestError(
      400,
      "invalid-page-size",
      `page[size] must be an integer from 1 to ${maximumPageSize}.`,
      "page[size]",
    );
  }

  return { size, after: searchParams.get("page[after]") };
}

export function paginateResources<T extends JsonApiResource>(
  resources: readonly T[],
  requestUrl: URL,
  page: JsonApiPage,
) {
  let start = 0;
  if (page.after !== null) {
    const cursorIndex = resources.findIndex(({ id }) => id === page.after);
    if (cursorIndex === -1) {
      throw new JsonApiRequestError(
        400,
        "invalid-page-cursor",
        "page[after] is not a resource in this collection.",
        "page[after]",
      );
    }
    start = cursorIndex + 1;
  }

  const data = resources.slice(start, start + page.size);
  return createCursorPage(data, requestUrl, page, {
    hasNext: start + data.length < resources.length,
    total: resources.length,
  });
}

export function createCursorPage<T extends JsonApiResource>(
  data: readonly T[],
  requestUrl: URL,
  page: JsonApiPage,
  options: { hasNext: boolean; total?: number },
) {
  const pageData = [...data];
  const links: JsonApiLinks = { self: requestUrl.toString() };
  if (options.hasNext && pageData.length > 0) {
    const next = new URL(requestUrl);
    next.searchParams.set("page[size]", String(page.size));
    next.searchParams.set("page[after]", pageData.at(-1)!.id);
    links.next = next.toString();
  }

  const meta: JsonApiMeta = { count: pageData.length };
  if (options.total !== undefined) meta.total = options.total;
  return {
    data: pageData,
    links,
    meta,
  };
}

export function parseIncludes(
  searchParams: URLSearchParams,
  allowed: ReadonlySet<string>,
) {
  const value = searchParams.get("include");
  if (!value) return new Set<string>();

  const includes = new Set(value.split(",").filter(Boolean));
  for (const include of includes) {
    if (!allowed.has(include)) {
      throw new JsonApiRequestError(
        400,
        "unsupported-include",
        `Unsupported include path: ${include}.`,
        "include",
      );
    }
  }
  return includes;
}

export function parseSparseFields(
  searchParams: URLSearchParams,
  allowed: Readonly<Record<string, ReadonlySet<string>>>,
) {
  const fields = new Map<string, Set<string>>();
  for (const [parameter, value] of searchParams) {
    const match = /^fields\[([^\]]+)]$/.exec(parameter);
    if (!match) continue;

    const type = match[1];
    const allowedFields = allowed[type];
    if (!allowedFields) {
      throw new JsonApiRequestError(
        400,
        "unsupported-resource-type",
        `Sparse fields are not supported for resource type ${type}.`,
        parameter,
      );
    }

    const selected = new Set(value.split(",").filter(Boolean));
    for (const field of selected) {
      if (!allowedFields.has(field)) {
        throw new JsonApiRequestError(
          400,
          "unsupported-field",
          `Unsupported field ${field} for resource type ${type}.`,
          parameter,
        );
      }
    }
    fields.set(type, selected);
  }
  return fields;
}

export function applySparseFields<T extends JsonApiResource>(
  resource: T,
  fields: ReadonlyMap<string, ReadonlySet<string>>,
): T {
  const selected = fields.get(resource.type);
  if (!selected) return resource;

  const attributes = resource.attributes
    ? Object.fromEntries(
        Object.entries(resource.attributes).filter(([name]) => selected.has(name)),
      )
    : undefined;
  const relationships = resource.relationships
    ? Object.fromEntries(
        Object.entries(resource.relationships).filter(([name]) => selected.has(name)),
      )
    : undefined;

  const filtered = { ...resource };
  if (attributes && Object.keys(attributes).length > 0) {
    filtered.attributes = attributes;
  } else {
    delete filtered.attributes;
  }
  if (relationships && Object.keys(relationships).length > 0) {
    filtered.relationships = relationships;
  } else {
    delete filtered.relationships;
  }
  return filtered;
}

function errorTitle(status: number) {
  if (status >= 500) return "Internal Server Error";
  if (status === 404) return "Not Found";
  return "Invalid Request";
}

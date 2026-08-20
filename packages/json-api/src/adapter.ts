import type {
  JsonApiRelationshipDeclaration,
  JsonApiRelationshipResolution,
  JsonApiResource,
} from "./core";

export type JsonApiResourceRequest = {
  resourceType: string;
  origin: string;
};

export type JsonApiResourceAdapter = {
  getResource: (
    request: JsonApiResourceRequest & { id: string },
  ) => Promise<JsonApiResource | null>;
  listResources: (
    request: JsonApiResourceRequest & {
      after: string | null;
      limit: number;
    },
  ) => Promise<JsonApiResource[]>;
  listResourcesByIds: (
    request: JsonApiResourceRequest & { ids: readonly string[] },
  ) => Promise<JsonApiResource[]>;
  resolveRelationships?: (request: {
    resources: readonly JsonApiResource[];
    relationship: JsonApiRelationshipDeclaration;
    origin: string;
  }) => Promise<JsonApiRelationshipResolution | undefined>;
};

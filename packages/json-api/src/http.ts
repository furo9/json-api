import {
  createJsonApiDocument,
  createJsonApiErrorDocument,
  type JsonApiImplementationDeclaration,
  type JsonApiRequestError,
} from "./core";

const JSON_API_MEDIA_TYPE = "application/vnd.api+json";
type JsonApiHttpSettings = JsonApiImplementationDeclaration["settings"]["http"];

export function jsonApiResponse(
  document: Record<string, unknown>,
  settings: JsonApiHttpSettings,
  status = 200,
) {
  const body = JSON.stringify(createJsonApiDocument(document));
  const headers = new Headers({
    ...corsHeaders(settings),
    "Cache-Control": settings.cache.browserCacheControl,
    "Content-Type": JSON_API_MEDIA_TYPE,
    "X-Content-Type-Options": "nosniff",
  });
  headers.set(
    settings.cache.sharedCacheControlHeader,
    `public, max-age=${settings.cache.sharedMaxAgeSeconds}`,
  );

  return new Response(body, { status, headers });
}

export function jsonApiErrorResponse(
  error: JsonApiRequestError,
  settings: JsonApiHttpSettings,
) {
  const response = new Response(
    JSON.stringify(createJsonApiErrorDocument(error)),
    {
      status: error.status,
      headers: {
        ...corsHeaders(settings),
        "Cache-Control": "no-store",
        "Content-Type": JSON_API_MEDIA_TYPE,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
  return response;
}

export function jsonApiOptionsResponse(settings: JsonApiHttpSettings) {
  return new Response(null, { status: 204, headers: corsHeaders(settings) });
}

function corsHeaders(settings: JsonApiHttpSettings) {
  return {
    "Access-Control-Allow-Headers": settings.cors.allowHeaders.join(", "),
    "Access-Control-Allow-Methods": settings.cors.allowMethods.join(", "),
    "Access-Control-Allow-Origin": settings.cors.allowOrigin,
  };
}

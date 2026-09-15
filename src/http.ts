/**
 * Shared HTTP plumbing: CORS headers, JSON/error envelopes, upstream error
 * classification, and the constant-time proxy-key check.
 */

import { timingSafeEqual } from "node:crypto";

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return origin
    ? { "access-control-allow-origin": origin, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }
    : {};
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

export function errorResponse(req: Request, status: number, message: string, type = "invalid_request_error"): Response {
  return jsonResponse(req, { error: { message, type } }, status);
}

// ─── Upstream error classification ──────────────────────────────────────────

export interface UpstreamErrorClass {
  /** HTTP status to surface to the caller. */
  status: number;
  /** Standard error type (OpenAI/Anthropic conventions). */
  type: string;
  /** OpenAI error code, when the class has a canonical one. */
  code?: string;
}

/**
 * Classify an upstream Devin/Codeium error into an HTTP status and a standard
 * error type. Codeium reports rate limits as a Connect end-stream trailer with
 * gRPC code `permission_denied` and a message that explicitly mentions the
 * rate limit, so the message text is the reliable signal — the code alone
 * would misclassify real permission errors. The standard gRPC quota code
 * `resource_exhausted` is accepted as a direct signal. Credential failures
 * (rejected session token / JWT) map to 401.
 */
export function classifyUpstreamError(message: string | undefined, code?: string): UpstreamErrorClass {
  if (/rate limit|rate_limit|quota/i.test(message ?? "") || code === "resource_exhausted") {
    return { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (code === "unauthenticated" || /unauthenticated|invalid api key|invalid token/i.test(message ?? "")) {
    return { status: 401, type: "authentication_error" };
  }
  return { status: 502, type: "api_error" };
}

// ─── Proxy key check ─────────────────────────────────────────────────────────

/** Constant-time compare of the request credential against PROXY_API_KEY. */
export function proxyAuthorized(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const apiKey = req.headers.get("x-api-key") ?? "";
  const provided = bearer || apiKey;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

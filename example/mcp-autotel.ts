// Opt-in entry point: only this handler bundles Autotel and its OpenTelemetry dependencies.
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server';
import { init } from 'autotel';
import { wrapHandler } from 'autotel-aws/lambda';
import { injectOtelContextToMeta } from 'autotel-mcp-instrumentation';
import { instrumentMcpServer } from 'autotel-mcp-instrumentation/server';
import { z } from 'zod';
import { createHandler, type HttpApiEvent } from './mcp';

// Tracing is the deployer's choice: off unless an OTLP endpoint is set. When on, a caller's
// W3C trace context in `_meta` parents the tool spans, so one trace runs agent → MCP → tool.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  init({
    service: process.env.OTEL_SERVICE_NAME ?? 'aws-cdk-mcp-example',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
}

// Read per request: a handful of string ops, and a config change needs no cold start to apply.
// Once autotel-aws > 1.2.1 and autotel-mcp-instrumentation > 59.0.0 are published, replace the
// helpers below with `{ extractTraceContext: (e) => traceCarrierOf(…body…) }` on wrapHandler.

/** A JSON-RPC request carrying W3C trace context in `params._meta`; other keys kept as-is. */
const TracedRequest = z.looseObject({
  params: z.looseObject({
    _meta: z.looseObject({
      traceparent: z.string(),
      tracestate: z.string().optional(),
      baggage: z.string().optional(),
    }),
  }),
});

type TracedRequest = z.infer<typeof TracedRequest>;

/** The boundary: a body that carries `_meta` trace context, parsed; anything else, undefined. */
function tracedRequestOf(text: string | null | undefined): TracedRequest | undefined {
  if (!text) return undefined;

  try {
    const parsed = TracedRequest.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // not JSON: the SDK answers that itself
  }
}

/** W3C fields only: `_meta` may carry other keys that don't belong in headers. */
function traceCarrierOf(request: TracedRequest) {
  const { traceparent, tracestate, baggage } = request.params._meta;

  return { traceparent, tracestate, baggage };
}

/** Where wrapHandler looks: so the invocation span joins the caller's trace. */
function withMetaTraceHeaders(event: HttpApiEvent): HttpApiEvent {
  const body =
    event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString() : event.body;

  const traced = tracedRequestOf(body);

  return traced ? { ...event, headers: { ...event.headers, ...traceCarrierOf(traced) } } : event;
}

/**
 * The body with `_meta.traceparent` pointing at the active span (this invocation), so the tool
 * span parents on it rather than skipping it for the caller. Undefined when there's nothing to
 * re-parent: tracing off, no `_meta` context, or a body past the SDK's own size bound.
 */
async function reparentedBody(request: Request): Promise<TracedRequest | undefined> {
  const text = await request.clone().text();

  // The SDK's bound is in UTF-8 bytes; `text.length` counts UTF-16 units, so `€` reads as 1, not 3.
  if (Buffer.byteLength(text, 'utf8') > DEFAULT_MAX_REQUEST_BODY_SIZE) return undefined;

  const traced = tracedRequestOf(text);
  const { traceparent } = injectOtelContextToMeta();

  if (!traced || !traceparent) return undefined;

  // The caller's tracestate and baggage still apply; only the parent changes.
  return {
    ...traced,
    params: { ...traced.params, _meta: { ...traced.params._meta, traceparent } },
  };
}

const traced = wrapHandler(
  createHandler({
    instrumentServer: (server) => instrumentMcpServer(server, { networkTransport: 'tcp' }),
    prepareRequest: async (request) => {
      const body = await reparentedBody(request);

      return body
        ? new Request(request, { method: request.method, body: JSON.stringify(body) })
        : request;
    },
  }),
);

export const handler = (event: HttpApiEvent, context: Parameters<typeof traced>[1]) =>
  traced(withMetaTraceHeaders(event), context);

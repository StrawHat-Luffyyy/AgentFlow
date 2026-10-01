import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

function traceEndpoint(baseEndpoint: string): string {
  const url = new URL(baseEndpoint);
  if (!url.pathname.endsWith("/v1/traces")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  }
  return url.toString();
}

export interface TelemetrySdk {
  shutdown(): Promise<void>;
}

export function startTelemetry(options: {
  serviceName: string;
  serviceVersion?: string;
  endpoint?: string;
}): TelemetrySdk {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.1.0",
    }),
    ...(options.endpoint
      ? { traceExporter: new OTLPTraceExporter({ url: traceEndpoint(options.endpoint) }) }
      : { spanProcessors: [] }),
  });
  sdk.start();
  return sdk;
}

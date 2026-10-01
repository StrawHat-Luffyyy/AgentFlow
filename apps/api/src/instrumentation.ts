import { startTelemetry } from "@agentflow/telemetry";

export const telemetry = startTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME || "agentflow-api",
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});

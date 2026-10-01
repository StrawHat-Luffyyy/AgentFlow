import { startTelemetry } from "@agentflow/telemetry";

export const telemetry = startTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME || "agentflow-worker",
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
});

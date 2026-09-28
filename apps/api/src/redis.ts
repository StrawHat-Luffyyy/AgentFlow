import type { ConnectionOptions } from "bullmq";

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const connection: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
  };
  if (url.username) connection.username = decodeURIComponent(url.username);
  if (url.password) connection.password = decodeURIComponent(url.password);
  if (url.pathname.length > 1) connection.db = Number(url.pathname.slice(1));
  if (url.protocol === "rediss:") connection.tls = {};
  return connection;
}

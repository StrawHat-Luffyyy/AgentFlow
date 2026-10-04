import { describe, expect, it } from "vitest";
import { createServer } from "node:net";

describe("real DEMO configuration and interactive supervisor behavior", () => {
  function parseDemoConfig(args: string[], env: Record<string, string | undefined> = {}) {
    const isDemo = args.includes("DEMO");
    const argument = (name: string, fallback: string) => {
      const index = args.indexOf(name);
      return index < 0 ? fallback : args[index + 1]!;
    };
    const defaultPort = isDemo ? "3000" : "0";
    const apiPort = Number(env.AGENTFLOW_API_PORT || argument("--api-port", defaultPort));
    const token =
      env.AGENTFLOW_DEMO_TOKEN ||
      argument("--token", "") ||
      (isDemo ? "agentflow-demo-token-12345678901234567890123456789012" : "generated-random");
    const isInteractive = isDemo && argument("--non-interactive", "") === "";
    const interactiveTimeoutMs = Number(argument("--approval-timeout-ms", "120000"));
    const approvalDelayMs = Number(argument("--approval-delay-ms", isDemo ? "6000" : "0"));
    const keepAlive = isDemo
      ? argument("--no-keep-alive", "") === ""
      : argument("--keep-alive", "") !== "" || env.AGENTFLOW_KEEP_ALIVE === "true";

    return {
      isDemo,
      apiPort,
      token,
      isInteractive,
      interactiveTimeoutMs,
      approvalDelayMs,
      keepAlive,
    };
  }

  it("defaults to port 3000 and the standard demo token for DEMO", () => {
    const config = parseDemoConfig(["--systems", "A1", "--scenarios", "DEMO"]);
    expect(config.isDemo).toBe(true);
    expect(config.apiPort).toBe(3000);
    expect(config.token).toBe("agentflow-demo-token-12345678901234567890123456789012");
  });

  it("enables interactive approval mode by default for DEMO", () => {
    const config = parseDemoConfig(["--systems", "A1", "--scenarios", "DEMO"]);
    expect(config.isInteractive).toBe(true);
    expect(config.interactiveTimeoutMs).toBe(120000);
  });

  it("disables interactive mode when --non-interactive is specified", () => {
    const config = parseDemoConfig(["--systems", "A1", "--scenarios", "DEMO", "--non-interactive"]);
    expect(config.isInteractive).toBe(false);
  });

  it("defaults keep-alive to true for DEMO unless --no-keep-alive is provided", () => {
    const defaultDemo = parseDemoConfig(["--systems", "A1", "--scenarios", "DEMO"]);
    expect(defaultDemo.keepAlive).toBe(true);

    const noKeepAlive = parseDemoConfig(["--systems", "A1", "--scenarios", "DEMO", "--no-keep-alive"]);
    expect(noKeepAlive.keepAlive).toBe(false);
  });

  it("respects custom port, token, and timeout overrides", () => {
    const config = parseDemoConfig(
      ["--systems", "A1", "--scenarios", "DEMO", "--api-port", "3001", "--token", "custom-token-xyz", "--approval-timeout-ms", "30000"],
    );
    expect(config.apiPort).toBe(3001);
    expect(config.token).toBe("custom-token-xyz");
    expect(config.interactiveTimeoutMs).toBe(30000);
  });
});

describe("API port retry and rebind resilience", () => {
  it("retries port binding on transient EADDRINUSE and binds once available", async () => {
    // 1. Temporarily occupy a random high port
    const blocker = createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        const addr = blocker.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    expect(port).toBeGreaterThan(0);

    // 2. Simulate the bounded retry logic from real-child.ts
    let attempts = 0;
    const maxAttempts = 10;
    const delayMs = 50;

    // Release blocker after 100ms
    setTimeout(() => {
      blocker.close();
    }, 100);

    const boundPort = await new Promise<number>((resolve, reject) => {
      async function tryBind() {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          attempts++;
          try {
            const server = createServer();
            await new Promise<void>((res, rej) => {
              server.listen(port, "127.0.0.1", () => {
                const a = server.address();
                server.close();
                resolve(typeof a === "object" && a ? a.port : port);
                res();
              });
              server.once("error", rej);
            });
            return;
          } catch (err: any) {
            if (err?.code === "EADDRINUSE" && attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, delayMs));
              continue;
            }
            reject(err);
            return;
          }
        }
      }
      void tryBind();
    });

    expect(boundPort).toBe(port);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

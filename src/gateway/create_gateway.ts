import { serve } from "@hono/node-server";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import {
  assertLoopbackBindHost,
  LOOPBACK_HOST,
  type StartupConfig,
} from "../config/startup_config.js";
import { AdmissionController, defaultDelay, type DelayFn } from "./admission.js";
import { createHonoApp, type RouteRegistration } from "./hono_app.js";
import type { TimeoutScheduler } from "./timeouts.js";

export interface Gateway {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface HostedGateway extends Gateway {
  listen(): Promise<{ host: typeof LOOPBACK_HOST; port: number }>;
}

export interface GatewayConfig {
  readonly startup: StartupConfig;
  readonly runtime: RuntimeConfigSnapshot;
}

export interface GatewayDependencies {
  readonly nowMs?: () => number;
  readonly delay?: DelayFn;
  readonly createRequestId?: () => string;
  readonly isReady?: () => boolean;
}

export type { RouteRegistration };

export async function createGateway(
  config: Readonly<GatewayConfig>,
  routes: readonly RouteRegistration[],
  dependencies: Readonly<GatewayDependencies> = {},
): Promise<HostedGateway> {
  assertLoopbackBindHost(config.startup.host);

  const nowMs = dependencies.nowMs ?? Date.now;
  const delay = dependencies.delay ?? defaultDelay;
  const scheduler: TimeoutScheduler = { nowMs, delay };
  const admission = new AdmissionController(delay, nowMs);
  const inflight = new Set<AbortController>();
  let closed = false;
  const app = createHonoApp(routes, {
    runtime: config.runtime,
    admission,
    scheduler,
    createRequestId: dependencies.createRequestId ?? defaultRequestId,
    isReady: dependencies.isReady ?? (() => true),
    isClosed: () => closed,
    inflight,
  });

  let listener: ReturnType<typeof serve> | undefined;

  const gateway: HostedGateway = {
    fetch(request: Request): Promise<Response> {
      if (closed) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(app.fetch(request));
    },
    async listen(): Promise<{ host: typeof LOOPBACK_HOST; port: number }> {
      assertLoopbackBindHost(config.startup.host);
      if (listener !== undefined) {
        return { host: LOOPBACK_HOST, port: config.startup.port };
      }
      listener = serve({
        fetch: app.fetch,
        hostname: LOOPBACK_HOST,
        port: config.startup.port,
      });
      return { host: LOOPBACK_HOST, port: config.startup.port };
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const controller of inflight) {
        controller.abort();
      }
      inflight.clear();
      admission.close();
      const current = listener;
      listener = undefined;
      if (current !== undefined) {
        await new Promise<void>((resolve, reject) => {
          current.close((error?: Error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    },
  };

  return gateway;
}

function defaultRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

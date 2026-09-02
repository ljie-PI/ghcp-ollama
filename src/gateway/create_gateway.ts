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

export type LoopbackOrigin = `http://127.0.0.1:${number}`;

export interface GatewayActivity {
  snapshot(): Readonly<{
    activeRequests: number;
    activeStreams: number;
    queuedRequests: number;
  }>;
}

export interface AdminRequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly listenerOrigin: LoopbackOrigin;
  readonly activity: GatewayActivity;
}

export type AdminBootstrapResult =
  | { readonly kind: "issued"; readonly token: string; readonly expiresAt: string }
  | { readonly kind: "capacity" }
  | { readonly kind: "closed" };

export interface AdminModule {
  handle(request: Request, context: Readonly<AdminRequestContext>): Promise<Response>;
  mintBootstrap(): AdminBootstrapResult;
  close(): void;
}

export interface AdminStaticModule {
  handle(request: Request, signal: AbortSignal): Promise<Response>;
}

export interface LocalControlModule {
  handle(
    request: Request,
    context: Readonly<{
      requestId: string;
      signal: AbortSignal;
      listenerOrigin: LoopbackOrigin;
    }>,
  ): Promise<Response>;
  close(): void;
}

export interface GatewayDependencies {
  readonly nowMs?: () => number;
  readonly delay?: DelayFn;
  readonly createRequestId?: () => string;
  readonly isReady?: () => boolean;
  readonly onClose?: () => Promise<void> | void;
  readonly admin?: AdminModule;
  readonly control?: LocalControlModule;
  readonly adminStatic?: AdminStaticModule;
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
  const mountedInflight = new Set<AbortController>();
  let activeStreams = 0;
  let closed = false;
  const activity: GatewayActivity | undefined = dependencies.admin === undefined
    ? undefined
    : {
      snapshot: () => ({
        activeRequests: admission.activeCount,
        activeStreams,
        queuedRequests: admission.queuedCount,
      }),
    };
  const appDependencies = {
    runtime: config.runtime,
    admission,
    scheduler,
    createRequestId: dependencies.createRequestId ?? defaultRequestId,
    isReady: dependencies.isReady ?? (() => true),
    isClosed: () => closed,
    inflight,
    mountedInflight,
    listenerOrigin: `http://${LOOPBACK_HOST}:${config.startup.port}` as LoopbackOrigin,
    ...(dependencies.admin === undefined ? {} : { admin: dependencies.admin }),
    ...(dependencies.control === undefined ? {} : { control: dependencies.control }),
    ...(dependencies.adminStatic === undefined ? {} : { adminStatic: dependencies.adminStatic }),
    ...(activity === undefined
      ? {}
      : {
        activity,
        streamStarted: () => {
          activeStreams += 1;
        },
        streamFinished: () => {
          activeStreams = Math.max(0, activeStreams - 1);
        },
      }),
  };
  const app = createHonoApp(routes, appDependencies);

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
      for (const controller of mountedInflight) {
        controller.abort();
      }
      mountedInflight.clear();
      let closeError: unknown;
      try {
        dependencies.control?.close();
      } catch (error: unknown) {
        closeError ??= error;
      }
      try {
        dependencies.admin?.close();
      } catch (error: unknown) {
        closeError ??= error;
      }
      for (const controller of inflight) {
        controller.abort();
      }
      inflight.clear();
      admission.close();
      const current = listener;
      listener = undefined;
      if (current !== undefined) {
        try {
          await new Promise<void>((resolve, reject) => {
            current.close((error?: Error) => {
              if (error !== undefined) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        } catch (error: unknown) {
          closeError ??= error;
        }
      }
      try {
        await dependencies.onClose?.();
      } catch (error: unknown) {
        closeError ??= error;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
    },
  };

  return gateway;
}

function defaultRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

import type { HostedGateway } from "../gateway/create_gateway.js";
import type { DaemonRuntimeComposition } from "./runtime.js";

export async function composeLazyProductionDaemonGateway(
  context: Readonly<DaemonRuntimeComposition>,
): Promise<HostedGateway> {
  return await (await import("../main.js")).composeProductionDaemonGateway(context);
}

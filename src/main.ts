import { defaultRuntimeConfigSnapshot } from "./config/schema.js";
import { parseStartupConfig } from "./config/startup_config.js";
import { createGateway, type Gateway, type GatewayDependencies, type RouteRegistration } from "./gateway/create_gateway.js";

export interface BootstrapOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly routes?: readonly RouteRegistration[];
  readonly dependencies?: Readonly<GatewayDependencies>;
  readonly homedir?: string;
}

export async function bootstrapGateway(options: BootstrapOptions = {}): Promise<Gateway> {
  const startup = parseStartupConfig(
    options.argv ?? [],
    options.env ?? {},
    options.homedir === undefined ? {} : { homedir: options.homedir },
  );
  return createGateway(
    {
      startup,
      runtime: defaultRuntimeConfigSnapshot(),
    },
    options.routes ?? [],
    options.dependencies ?? {},
  );
}

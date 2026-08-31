export const SDK_TEST_GUARD = "GHC_GATEWAY_SDK_TESTS";

export function assertOfflineSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[SDK_TEST_GUARD] !== "1") {
    throw new Error(`${SDK_TEST_GUARD}=1 is required for manual offline SDK tests`);
  }
}

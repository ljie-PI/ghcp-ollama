export const LIVE_SDK_TEST_GUARD = "GHC_GATEWAY_LIVE_TESTS";

export function assertLiveSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[LIVE_SDK_TEST_GUARD] !== "1") {
    throw new Error(`${LIVE_SDK_TEST_GUARD}=1 is required for manual live SDK tests`);
  }
}

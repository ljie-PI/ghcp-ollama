export const COPILOT_IDENTITY = {
  editorName: "vscode",
  editorVersion: "1.110.1",
  pluginName: "copilot-chat",
  pluginVersion: "0.38.2",
  integrationId: "vscode-chat",
  apiVersion: "2025-10-01",
} as const;

export function copilotHeaders(): Record<string, string> {
  return {
    "copilot-integration-id": COPILOT_IDENTITY.integrationId,
    "editor-version": `${COPILOT_IDENTITY.editorName}/${COPILOT_IDENTITY.editorVersion}`,
    "editor-plugin-version": `${COPILOT_IDENTITY.pluginName}/${COPILOT_IDENTITY.pluginVersion}`,
    "user-agent": `GitHubCopilotChat/${COPILOT_IDENTITY.pluginVersion}`,
    "x-github-api-version": COPILOT_IDENTITY.apiVersion,
  };
}

export const STRIP_ON_CROSS_HOST = [
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
  "www-authenticate",
] as const;

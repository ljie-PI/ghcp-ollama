import os from "os";
import path from "path";

export function sysConfigPath() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "ghcpo-server", "config");
  }
  return path.join(os.homedir(), ".ghcpo-server", "config");
}

export const editorConfig = {
  editorInfo: {
    name: "Neovim",
    version: "0.10.3",
  },
  editorPluginInfo: {
    name: "copilot.lua",
    version: "1.43.0",
  },
  copilotIntegrationId: "vscode-chat",
};

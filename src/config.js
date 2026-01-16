import os from "os";
import path from "path";

export function sysConfigPath() {
  if (os.platform() === "win32") {
    return path.join(os.homedir(), "AppData", "Local", "github-copilot");
  }

  const homedir = process.env.XDG_CONFIG_HOME || os.homedir();
  return path.join(homedir, ".config", "github-copilot");
}

export const editorConfig = {
  editorInfo: {
    name: "Neovim",
    version: "0.11.4",
  },
  editorPluginInfo: {
    name: "copilot.vim",
    version: "1.59.0",
  },
  copilotIntegrationId: "vscode-chat",
};

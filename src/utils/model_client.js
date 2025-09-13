/**
 * Manages GitHub Copilot model operations
 * Handles model listing, selection, and persistence of model preferences.
 */

import fs from "fs";
import path from "path";
import { CopilotAuth } from "./auth_client.js";
import { sendHttpRequest } from "./http_utils.js";
import { editorConfig, sysConfigPath } from "../config.js";

export class CopilotModels {
  constructor() {
    this.auth = new CopilotAuth();
    this.modelConfigFile = path.join(sysConfigPath(), "model-config.json");
  }

  /**
   * Fetches available Copilot models from the GitHub API
   * Requires valid authentication token
   *
   * @returns {Promise<Object>} Result object containing:
   *   - success: {boolean} Whether the operation was successful
   *   - availableModels: {Array<Object>} List of available models, each containing:
   *     - id: {string} Unique model identifier
   *     - name: {string} Human-readable model name
   *     - vendor: {string} Model vendor/provider
   *     - version: {string} Model version
   */
  async getAvailableModels() {
    try {
      const signInStatus = this.auth.checkStatus();
      if (!signInStatus.authenticated || !signInStatus.tokenValid) {
        return {
          success: false,
          availableModels: [],
          error: "Not signed in or token is invalid.",
        };
      }

      const { token, endpoint } = this.auth.getGithubToken();
      if (!token) {
        return {
          success: false,
          availableModels: [],
          error: "Can't get Github token.",
        };
      }
      if (!endpoint) {
        return {
          success: false,
          availableModels: [],
          error: "Can't get Github endpoint.",
        };
      }

      const modelsResponse = await this.#requestModels(endpoint, token);

      let modelsList = [];
      if (
        modelsResponse &&
        modelsResponse.data &&
        Array.isArray(modelsResponse.data)
      ) {
        modelsList = this.#getLatestVersion(modelsResponse.data).map(
          (model) => ({
            id: model.id,
            name: model.name,
            vendor: model.vendor,
            version: model.version,
            capabilities: model.capabilities,
          }),
        );
      } else {
        return { success: false, availableModels: [] };
      }
      return { success: true, availableModels: modelsList };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Sets the active Copilot model and persists the selection
   *
   * @param {string} modelId - The ID of the model to set as active
   *
   * @returns {Promise<Object>} Result object containing:
   *   - success: {boolean} Whether the operation was successful
   *   - modelId: {string} ID of the selected model (if successful)
   *   - modelName: {string} Name of the selected model (if successful)
   *   - error: {string} Error message (if failed)
   */
  async setModel(modelId) {
    try {
      const modelsResult = await this.getAvailableModels();
      const modelInfo = modelsResult.availableModels.find(
        (model) => model.id === modelId,
      );

      if (modelInfo === undefined) {
        return {
          success: false,
          error: `Model with ID "${modelId}" not available.`,
        };
      }

      const modelConfig = {
        modelId: modelId,
        modelName: modelInfo.name,
        vendor: modelInfo.vendor,
        version: modelInfo.version,
        capabilities: modelInfo.capabilities,
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(
        this.modelConfigFile,
        JSON.stringify(modelConfig, null, 2),
        "utf8",
      );

      return {
        success: true,
        modelConfig,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Retrieves the currently selected model configuration
   * If no model is configured, returns and persists default model settings
   *
   * @returns {Promise<Object>} Result object containing:
   *   - success: {boolean} Whether the operation was successful
   *   - modelId: {string} ID of the current model
   *   - modelName: {string} Name of the current model
   *   - lastUpdated: {string} ISO timestamp of last update
   *   - error: {string} Error message (if failed)
   */
  async getCurrentModel() {
    try {
      if (fs.existsSync(this.modelConfigFile)) {
        const modelConfigData = fs.readFileSync(this.modelConfigFile, "utf8");
        const modelConfig = JSON.parse(modelConfigData);

        return {
          success: true,
          modelConfig,
        };
      } else {
        return {
          success: false,
          error: "Model configuration file not found.",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async #requestModels(endpoint, token) {
    const url = new URL(`${endpoint}/models`);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "github-copilot",
      "Content-Type": "application/json",
      "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
      "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
    };
    const resp = await sendHttpRequest(
      url.hostname,
      url.pathname,
      "GET",
      headers,
      null,
      { timeout: 3000 },
    );
    if (resp.success) {
      return resp.data;
    }
    return null;
  }

  #getLatestVersion(models) {
    const latestVersion = {};
    for (const model of models) {
      if (
        !latestVersion[model.name] ||
        model.version > latestVersion[model.name].version
      ) {
        latestVersion[model.name] = model;
      }
    }
    return Object.values(latestVersion);
  }
}

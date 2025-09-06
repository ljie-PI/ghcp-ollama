/**
 * Github Copilot Authentication Manager
 *
 * This class handles all authentication-related operations for GitHub Copilot, including:
 * - Handling OAuth flow with GitHub
 * - Managing GitHub authentication tokens
 * - Storing and retrieving authentication credentials
 */

import fs from "fs";
import path from "path";
import { sendHttpRequest } from "./http_utils.js";
import { editorConfig, sysConfigPath } from "../config.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_HOST = "api.github.com";
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_ENDPOINT = "/login/device/code";
const ACCESS_TOKEN_ENDPOINT = "/login/oauth/access_token";
const USER_INFO_ENDPOINT = "/user";
const COPILOT_API_KEY_ENDPOINT = "/copilot_internal/v2/token";

class AuthStatus {
  constructor() {
    this.user = null;
    this.authenticated = false;
    this.tokenExists = false;
    this.tokenValid = false;
  }
}

const DeviceAuthStatus = Object.freeze({
  FAILED: "failed",
  COMPLETE: "complete",
  PENDING: "pending",
});

export class CopilotAuth {
  constructor() {
    this.configPath = sysConfigPath();
    this.oauthTokenPath = path.join(this.configPath, "auth-token.json");
    this.githubTokenPath = path.join(this.configPath, "github-token.json");

    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath, { recursive: true });
    }
  }

  /**
   * Checks the current authentication status with GitHub Copilot
   *
   * @returns {AuthStatus} Status object containing user authentication information
   */
  checkStatus() {
    const status = new AuthStatus();

    const authInfo = this.#getAuthInfo();
    if (!authInfo.user || !authInfo.oauth_token) {
      return status;
    }
    status.user = authInfo.user;
    status.authenticated = true;

    const tokenInfo = this.getGithubToken();
    if (tokenInfo.token) {
      status.tokenExists = true;
      status.tokenValid = !tokenInfo.expired;
    }

    return status;
  }

  /**
   * Initiates the GitHub Copilot sign-in process
   *
   * @param {boolean} [force=false] - Force re-authentication even if already signed in
   *
   * @returns {Promise<boolean>} True if sign-in successful, false otherwise
   */
  async signIn(force = false) {
    const status = this.checkStatus();
    if (status.authenticated && status.tokenValid && !force) {
      console.log("Signed in as user:", status.user);
      return true;
    }

    try {
      if (!status.authenticated) {
        await this.#signInGithHub();
      }
      if (!status.tokenValid || force) {
        await this.#fetchAndStoreGitHubToken();
      }
      const finalStatus = this.checkStatus();
      console.log("Signed in as user:", finalStatus.user);
      return finalStatus.authenticated && finalStatus.tokenValid;
    } catch (error) {
      console.error("Error signing in:", error);
      return false;
    }
  }

  /**
   * Signs out the current user from GitHub Copilot
   *
   * @returns {Promise<boolean>} True if sign-out successful, false otherwise
   */
  async signOut() {
    const status = this.checkStatus();

    if (!status.user) {
      console.log("Not signed in");
      return true;
    }

    try {
      if (fs.existsSync(this.oauthTokenPath)) {
        fs.unlinkSync(this.oauthTokenPath);
      }

      if (fs.existsSync(this.githubTokenPath)) {
        fs.unlinkSync(this.githubTokenPath);
      }

      console.log(`Signed out from GitHub Copilot as user: ${status.user}`);
      return true;
    } catch (error) {
      console.error("Error signing out:", error);
      return false;
    }
  }

  /**
   * Retrieves the stored GitHub token and API endpoint if available
   *
   * @returns {Object|null} An object containing:
   *   - endpoint: {string|null} The GitHub API endpoint URL
   *   - token: {string|null} The GitHub token if found and valid
   *   - expired: {boolean} True if the token is expired, false otherwise
   *   Returns null if token retrieval fails
   */
  getGithubToken() {
    const tokenInfo = { endpoint: null, token: null, expired: true };

    try {
      if (fs.existsSync(this.githubTokenPath)) {
        const tokenContent = fs.readFileSync(this.githubTokenPath, "utf8");
        const tokenData = JSON.parse(tokenContent);
        if (!tokenData.endpoints || !tokenData.token || !tokenData.expires_at) {
          return tokenInfo;
        }
        tokenInfo.endpoint = tokenData.endpoints.api;
        tokenInfo.token = tokenData.token;
        tokenInfo.expired = this.#checkTokenExpired(tokenData);
      }

      return tokenInfo;
    } catch (error) {
      console.error("Error getting token info:", error);
      return tokenInfo;
    }
  }

  #getAuthInfo() {
    const authInfo = { user: null, oauth_token: null };

    try {
      if (fs.existsSync(this.oauthTokenPath)) {
        const oauthContent = fs.readFileSync(this.oauthTokenPath, "utf8");
        const oauthData = JSON.parse(oauthContent);
        if (oauthData.user) {
          authInfo.user = oauthData.user;
        }
        if (oauthData.oauth_token) {
          authInfo.oauth_token = oauthData.oauth_token;
        }
      }

      return authInfo;
    } catch (error) {
      console.error("Error getting auth info:", error);
      return authInfo;
    }
  }

  #checkTokenExpired(tokenData) {
    if (tokenData.expires_at) {
      const expiresAt = new Date(tokenData.expires_at * 1000);
      const now = new Date();

      if (expiresAt < now) {
        console.log(`GitHub token expires at: ${expiresAt}`);
        console.log(`Current time: ${now}`);
        console.log("GitHub token is expired");
        return true;
      }

      return false;
    } else {
      console.log("GitHub token doesn't have an expiration date");
      return false;
    }
  }

  async #signInGithHub() {
    console.log("Starting GitHub Copilot authentication...");

    const deviceAuthData = await this.#authDevice();
    if (
      !deviceAuthData ||
      !deviceAuthData.device_code ||
      !deviceAuthData.user_code ||
      !deviceAuthData.verification_uri
    ) {
      throw new Error(
        `Invalid device authorization response: ${deviceAuthData}`,
      );
    }
    console.log("\n=== GitHub Copilot Authentication ===");
    console.log(`Your one-time code: ${deviceAuthData.user_code}`);
    console.log(`Please visit: ${deviceAuthData.verification_uri}`);
    console.log("Enter the code there to authenticate with GitHub Copilot");
    console.log("Waiting for authentication to complete...\n");

    const pollInterval = (deviceAuthData.interval ?? 3) * 1000;
    let pollTimeOut = 120 * 1000;
    let response = { status: DeviceAuthStatus.PENDING };
    while (pollTimeOut > 0) {
      response = await this.#poll(deviceAuthData.device_code);

      if (response.status === DeviceAuthStatus.FAILED) {
        throw new Error("Device authorization failed");
      }

      if (response.status === DeviceAuthStatus.COMPLETE) {
        fs.writeFileSync(
          this.oauthTokenPath,
          JSON.stringify(response, null, 2),
          "utf8",
        );
        console.log(
          `Successfully authenticated as GitHub user: ${response.user}`,
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      pollTimeOut -= pollInterval;
    }

    console.error("Device authorization timed out");
  }

  async #fetchAndStoreGitHubToken() {
    console.log("Fetching GitHub token...");

    const authInfo = this.#getAuthInfo();
    if (!authInfo.user || !authInfo.oauth_token) {
      throw new Error("Github Copilot authentication is not complete.");
    }

    const tokenData = await this.#requestGitHubToken(authInfo.oauth_token);
    if (tokenData.data) {
      fs.writeFileSync(
        this.githubTokenPath,
        JSON.stringify(tokenData.data, null, 2),
        "utf8",
      );
      console.log("GitHub token stored successfully");
    } else {
      throw new Error("Failed to fetch GitHub token");
    }
  }

  async #authDevice() {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-copilot",
    };
    const payload = {
      client_id: CLIENT_ID,
      scope: "read:user",
    };
    const { success, data } = await sendHttpRequest(
      GITHUB_HOST,
      DEVICE_CODE_ENDPOINT,
      "POST",
      headers,
      payload,
      { timeout: 3000 },
    );
    if (!success) {
      throw new Error("Failed to initiate device authorization");
    }
    return data;
  }

  async #poll(device_code) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-copilot",
    };
    const payload = {
      client_id: CLIENT_ID,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    };
    const { success, data } = await sendHttpRequest(
      GITHUB_HOST,
      ACCESS_TOKEN_ENDPOINT,
      "POST",
      headers,
      payload,
      { timeout: 3000 },
    );

    if (!success) {
      return { status: DeviceAuthStatus.FAILED };
    }
    if (data.error) {
      if (data.error === "authorization_pending") {
        return { status: DeviceAuthStatus.PENDING };
      }
      return { status: DeviceAuthStatus.FAILED };
    }

    if (data.access_token) {
      const userInfo = await this.#getUserInfo(data.access_token);
      return {
        status: DeviceAuthStatus.COMPLETE,
        user: userInfo && userInfo.login || "",
        oauth_token: data.access_token,
      };
    }

    return { status: DeviceAuthStatus.PENDING };
  }

  async #getUserInfo(accessToken) {
    try {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "github-copilot",
      };

      const { success, data } = await sendHttpRequest(
        GITHUB_API_HOST,
        USER_INFO_ENDPOINT,
        "GET",
        headers,
        null,
        { timeout: 3000 },
      );

      if (!success) {
        console.error("Failed to get user info from GitHub API");
        return null;
      }

      return data;
    } catch (error) {
      console.error("Error getting user info:", error);
      return null;
    }
  }

  async #requestGitHubToken(oauthToken) {
    const headers = {
      Authorization: `Bearer ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": "github-copilot",
      "Copilot-Integration-Id": editorConfig.copilotIntegrationId,
      "Editor-Version": `${editorConfig.editorInfo.name}/${editorConfig.editorInfo.version}`,
      "Editor-Plugin-Version": `${editorConfig.editorPluginInfo.name}/${editorConfig.editorPluginInfo.version}`,
    };
    return await sendHttpRequest(
      GITHUB_API_HOST,
      COPILOT_API_KEY_ENDPOINT,
      "GET",
      headers,
      null,
      { timeout: 3000 },
    );
  }
}

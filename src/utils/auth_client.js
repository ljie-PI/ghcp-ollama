/**
 * Github Copilot Authentication Manager
 *
 * This class handles all authentication-related operations for GitHub Copilot, including:
 * - Handling OAuth flow with GitHub
 * - Managing GitHub authentication tokens
 * - Storing and retrieving authentication credentials
 */

import fs from "fs";
import open from "open";
import path from "path";
import { sendHttpRequest } from "./http_utils.js";
import { sysConfigPath } from "../config.js";

export class CopilotAuth {
  constructor(lspClient) {
    this.lspClient = lspClient;

    this.configPath = sysConfigPath();
    this.oauthTokenPath = path.join(this.configPath, "apps.json");
    this.githubTokenPath = path.join(this.configPath, "github-token.json");

    if (!fs.existsSync(this.configPath)) {
      fs.mkdirSync(this.configPath, { recursive: true });
    }
  }

  /**
   * Checks the current authentication status with GitHub Copilot
   *
   * @param {Object} params - Optional parameters to pass to the LSP status check
   *
   * @returns {Object} Status object containing:
   *   - user: {string|null} The authenticated user's name
   *   - lspStatus: {string} The LSP connection status
   *   - authenticated: {boolean} Whether the user is authenticated
   *   - tokenExists: {boolean} Whether the GitHub token file exists
   *   - tokenValid: {boolean} Whether the token is valid and not expired
   */
  async checkStatus(params = {}) {
    const status = {};
    try {
      const lspStatus = await this.lspClient.request("checkStatus", params);
      status.user = lspStatus.user || null;
      status.lspStatus = lspStatus.status || "Unknown";
      status.authenticated = !!lspStatus.user;
    } catch (error) {
      console.error("Error checking status with LSP:", error);
      status.lspStatus = "Error";
      status.authenticated = false;
    }

    status.tokenExists = fs.existsSync(this.githubTokenPath);

    if (status.tokenExists) {
      try {
        const tokenContent = fs.readFileSync(this.githubTokenPath, "utf8");
        const tokenData = JSON.parse(tokenContent);
        status.tokenExpired = this.#checkTokenExpired(tokenData);
        status.tokenValid = !status.tokenExpired;
      } catch (error) {
        console.error("Error parsing GitHub token:", error);
        status.tokenValid = false;
      }
    } else {
      status.tokenExists = false;
      status.tokenValid = false;
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
    const status = await this.checkStatus();
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
      const finalStatus = await this.checkStatus();
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
    const status = await this.checkStatus({
      options: { localChecksOnly: true },
    });

    if (!status.user) {
      console.log("Not currently signed in");
      return true;
    }

    try {
      await this.lspClient.request("signOut", {});

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
   *   - token: {string|null} The GitHub token if found and valid
   *   - endpoint: {string|null} The GitHub API endpoint URL
   *   Returns null if token retrieval fails
   */
  getGithubToken() {
    try {
      let githubToken = null;
      let apiEndpoint = null;
      if (fs.existsSync(this.githubTokenPath)) {
        const tokenContent = fs.readFileSync(this.githubTokenPath, "utf8");
        const tokenData = JSON.parse(tokenContent);
        apiEndpoint = tokenData.endpoints.api;
        githubToken = tokenData.token;
      }
      return { token: githubToken, endpoint: apiEndpoint };
    } catch (error) {
      console.error("Error getting Github token:", error);
      return null;
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

    const signInResponse = await this.lspClient.request("signInInitiate");
    if (!signInResponse.userCode || !signInResponse.verificationUri) {
      throw new Error("Invalid sign in response from Github Copilot");
    }

    const { userCode, verificationUri } = signInResponse;
    console.log("\n=== GitHub Copilot Authentication ===");
    console.log(`Your one-time code: ${userCode}`);
    console.log(`Please visit: ${verificationUri}`);
    console.log("Enter the code there to authenticate with GitHub Copilot");
    console.log("Waiting for authentication to complete...\n");
    await open(verificationUri);

    const confirmResponse = await this.lspClient.request("signInConfirm", {
      userCode,
    });
    if (confirmResponse.status.toLowerCase() !== "ok") {
      throw new Error(
        `Authentication failed from Github Copilot: ${confirmResponse.error?.message || "Unknown error"}`,
      );
    }

    console.log(
      `Successfully authenticated as GitHub user: ${confirmResponse.user}`,
    );
  }

  async #fetchAndStoreGitHubToken() {
    console.log("Fetching GitHub token...");

    if (!fs.existsSync(this.oauthTokenPath)) {
      throw new Error("Github Copilot authentication is not complete.");
    }

    const oauthContent = fs.readFileSync(this.oauthTokenPath, "utf8");
    const oauthData = JSON.parse(oauthContent);
    let oauthToken = null;
    for (const key in oauthData) {
      if (key.startsWith("github.com:") && oauthData[key].oauth_token) {
        oauthToken = oauthData[key].oauth_token;
        break;
      }
    }
    if (!oauthToken) {
      throw new Error(`OAuth token not found in file ${this.oauthTokenPath}`);
    }

    const tokenData = await this.#requestGitHubToken(oauthToken);
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

  async #requestGitHubToken(oauthToken) {
    return await sendHttpRequest(
      "api.github.com",
      "/copilot_internal/v2/token",
      "GET",
      {
        Authorization: `Bearer ${oauthToken}`,
        Accept: "application/json",
        "User-Agent": "github-copilot",
      },
    );
  }
}

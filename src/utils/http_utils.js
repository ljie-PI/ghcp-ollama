/**
 * Utility functions for making HTTP requests using Node.js https module.
 * Provides support for both regular and streaming HTTP requests.
 */

import https from "https";

/**
 * Sends an HTTP request and returns a promise with the response.
 *
 * @param {string} hostname - The target host
 * @param {string} path - The request path
 * @param {string} method - The HTTP method (GET, POST, etc.)
 * @param {Object} headers - Request headers
 * @param {Object|null} [payload=null] - Request body
 * @param {Object} [optional={}] - Other optional parameters
 *    {number} [timeout=-1] - Optional timeout in milliseconds, default -1, means not timeout
 *    {Function|null} [callback=null] - Optional callback to process response data
 *    {string} [respProcErrorMsg="Failed to parse response"] - Custom error message for response processing failures
 *    {string} [statusCodeErrorMsg="Returned status code"] - Custom error message for non-200 status codes
 *    {string} [reqErrorMsg="Error making request to endpoint"] - Custom error message for request failures
 *
 * @returns {Promise<{success: boolean, data: any}>} Response data wrapped in a success object
 */
export async function sendHttpRequest(
  hostname,
  path,
  method,
  headers,
  payload = null,
  optional = {}
) {
  const timeout = optional.timeout || -1;
  const callback = optional.callback || null;
  const respProcErrorMsg = optional.respProcErrorMsg || "Failed to parse response";
  const statusCodeErrorMsg = optional.statusCodeErrorMsg || "Returned status code";
  const reqErrorMsg = optional.reqErrorMsg || "Error making request to endpoint";

  return await new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      path: path,
      method: method,
      headers: headers,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const respData = callback ? callback(data) : JSON.parse(data);
            resolve({ success: true, data: respData });
          } catch (error) {
            reject(new Error(`${respProcErrorMsg}: ${error.message}`));
          }
        } else {
          reject(
            new Error(
              `${statusCodeErrorMsg}: ${res.statusCode}: ${JSON.stringify(data)}`,
            ),
          );
        }
      });
    });

    if (timeout > 0) {
      req.setTimeout(timeout);
      req.on("timeout", () => {
        reject(new Error(`${reqErrorMsg}: Request timed out`));
      });
    }

    req.on("error", (error) => {
      reject(new Error(`${reqErrorMsg}: ${error.message}`));
    });

    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

/**
 * Sends an HTTP request that handles streaming responses.
 *
 * @param {string} hostname - The target host
 * @param {string} path - The request path
 * @param {string} method - The HTTP method (GET, POST, etc.)
 * @param {Object} headers - Request headers
 * @param {Object|null} [payload=null] - Optional request body
 * @param {Object} [optional={}] - Other optional parameters
 *    {Function|null} [onResponse=null] - Callback function to handle streamed response chunks
 *    {Function|null} [parseResp=null] - Function to parse response chunks
 *    {string} [respProcErrorMsg="Failed to parse response"] - Custom error message for response processing failures
 *    {string} [statusCodeErrorMsg="Returned status code"] - Custom error message for non-200 status codes
 *    {string} [reqErrorMsg="Error making request to endpoint"] - Custom error message for request failures
 *
 * @returns {Promise<{success: boolean}>} Success status of the streaming request
 */
export async function sendHttpStreamingRequest(
  hostname,
  path,
  method,
  headers,
  payload = null,
  optional = {}
) {
  const onResponse = optional.onResponse || null;
  const parseResp = optional.parseResp || null;
  const respProcErrorMsg = optional.respProcErrorMsg || "Failed to parse response";
  const statusCodeErrorMsg = optional.statusCodeErrorMsg || "Returned status code";
  const reqErrorMsg = optional.reqErrorMsg || "Error making request to endpoint";

  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      path: path,
      method: method,
      headers: headers,
    };
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = "";

        res.on("data", (chunk) => {
          errorData += chunk;
        });

        res.on("end", () => {
          reject(
            new Error(
              `${statusCodeErrorMsg}: ${res.statusCode}: ${JSON.stringify(errorData)}`,
            ),
          );
        });
      }

      // buffer is used to hold the incomplete data inputted to the parseResp function
      let buffer = "";
      // incompleteResult is used to hold the incomplete data outputted by parseResp function
      const incompleteResult = {};

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        if (
          parseResp &&
          typeof parseResp === "function" &&
          onResponse &&
          typeof onResponse === "function"
        ) {
          try {
            const parsed = parseResp(buffer, incompleteResult);
            onResponse(parsed.parsedMessages, "data");
            buffer = parsed.remainBuffer;
          } catch (error) {
            reject(new Error(`${respProcErrorMsg}: ${error.message}`));
          }
        }
      });

      res.on("end", () => {
        if (
          parseResp &&
          typeof parseResp === "function" &&
          onResponse &&
          typeof onResponse === "function"
        ) {
          try {
            const parsed = parseResp(buffer, incompleteResult);
            onResponse(parsed.parsedMessages, "end");
          } catch (error) {
            reject(new Error(`${respProcErrorMsg}: ${error.message}`));
          }
        }
        resolve({ success: true });
      });
    });

    req.on("error", (error) => {
      reject(new Error(`${reqErrorMsg}: ${error.message}`));
    });

    if (payload) {
      req.write(JSON.stringify(payload));
    }
    req.end();
  });
}

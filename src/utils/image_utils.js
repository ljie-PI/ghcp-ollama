/**
 * Utility functions for image processing.
 */

/**
 * Detects the MIME type of an image from its base64-encoded data.
 * Uses magic byte signatures to identify common image formats.
 *
 * Supported formats:
 * - JPEG (image/jpeg)
 * - PNG (image/png)
 * - GIF (image/gif)
 * - WebP (image/webp)
 *
 * @param {string} base64String - Base64-encoded image data
 * @returns {string} Detected MIME type (defaults to 'image/jpeg' if unknown)
 */
export function detectImageType(base64String) {
  if (!base64String || typeof base64String !== "string") {
    return "image/jpeg";
  }

  // Magic byte signatures for common image formats (in base64)
  // These correspond to the first few bytes of each format:
  // - JPEG: FF D8 FF -> base64: /9j/
  // - PNG: 89 50 4E 47 0D 0A 1A 0A -> base64: iVBORw0KGgo
  // - GIF: 47 49 46 38 -> base64: R0lGOD (GIF89a) or R0lGOD (GIF87a)
  // - WebP: 52 49 46 46 ... 57 45 42 50 -> base64: UklGR...WEBP
  const signatures = {
    "/9j/": "image/jpeg",
    iVBOR: "image/png",
    R0lGO: "image/gif",
    UklGR: "image/webp",
  };

  for (const [prefix, mimeType] of Object.entries(signatures)) {
    if (base64String.startsWith(prefix)) {
      return mimeType;
    }
  }

  // Default to JPEG if format cannot be detected
  return "image/jpeg";
}

/**
 * Unit tests for image_utils.js
 */

import { describe, it, expect } from "vitest";
import { detectImageType } from "../../src/utils/image_utils.js";
import { sampleImages } from "./fixtures/test_cases.js";

describe("detectImageType", () => {
  describe("valid image formats", () => {
    it("should detect JPEG images", () => {
      expect(detectImageType(sampleImages.jpeg)).toBe("image/jpeg");
    });

    it("should detect PNG images", () => {
      expect(detectImageType(sampleImages.png)).toBe("image/png");
    });

    it("should detect GIF images", () => {
      expect(detectImageType(sampleImages.gif)).toBe("image/gif");
    });

    it("should detect WebP images", () => {
      expect(detectImageType(sampleImages.webp)).toBe("image/webp");
    });
  });

  describe("edge cases", () => {
    it("should return image/jpeg for unknown format", () => {
      const unknownBase64 = "AAAAAAAAAAAAAAAA";
      expect(detectImageType(unknownBase64)).toBe("image/jpeg");
    });

    it("should return image/jpeg for empty string", () => {
      expect(detectImageType("")).toBe("image/jpeg");
    });

    it("should return image/jpeg for null input", () => {
      expect(detectImageType(null)).toBe("image/jpeg");
    });

    it("should return image/jpeg for undefined input", () => {
      expect(detectImageType(undefined)).toBe("image/jpeg");
    });

    it("should return image/jpeg for non-string input", () => {
      expect(detectImageType(123)).toBe("image/jpeg");
      expect(detectImageType({})).toBe("image/jpeg");
      expect(detectImageType([])).toBe("image/jpeg");
    });
  });

  describe("magic byte detection", () => {
    it("should detect JPEG by /9j/ prefix", () => {
      expect(detectImageType("/9j/any-content-here")).toBe("image/jpeg");
    });

    it("should detect PNG by iVBOR prefix", () => {
      expect(detectImageType("iVBORany-content-here")).toBe("image/png");
    });

    it("should detect GIF by R0lGO prefix", () => {
      expect(detectImageType("R0lGOany-content-here")).toBe("image/gif");
    });

    it("should detect WebP by UklGR prefix", () => {
      expect(detectImageType("UklGRany-content-here")).toBe("image/webp");
    });
  });
});

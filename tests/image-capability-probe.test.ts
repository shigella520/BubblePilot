import { describe, expect, it } from "vitest";

import {
  imageCapabilityProbeDataUrl,
  isValidImageCapabilityProbeDataUrl,
} from "../modules/ai/image-capability-probe.js";

describe("image capability probe", () => {
  it("generates a structurally valid deterministic PNG", () => {
    expect(
      isValidImageCapabilityProbeDataUrl(imageCapabilityProbeDataUrl),
    ).toBe(true);
    const png = Buffer.from(
      imageCapabilityProbeDataUrl.slice("data:image/png;base64,".length),
      "base64",
    );
    expect(png.readUInt32BE(16)).toBe(768);
    expect(png.readUInt32BE(20)).toBe(512);
  });

  it.each([
    "",
    "data:image/jpeg;base64,AAAA",
    `${imageCapabilityProbeDataUrl.slice(0, -20)}AAAA`,
    `${imageCapabilityProbeDataUrl.slice(0, 60)}A${imageCapabilityProbeDataUrl.slice(61)}`,
  ])("rejects a malformed probe asset", (dataUrl) => {
    expect(isValidImageCapabilityProbeDataUrl(dataUrl)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { parseBlueBubblesLinkPreviews } from "../modules/integrations/bluebubbles/link-preview-parser.js";
import {
  OpenGraphClient,
  OpenGraphFetchError,
} from "../modules/integrations/bluebubbles/open-graph-client.js";

function archive() {
  return [
    {
      $version: 100_000,
      $archiver: "NSKeyedArchiver",
      $top: { root: { UID: 1 } },
      $objects: [
        "$null",
        { richLinkMetadata: { UID: 2 } },
        {
          originalURL: { UID: 3 },
          URL: { UID: 4 },
          title: { UID: 5 },
          summary: { UID: 6 },
          siteName: { UID: 7 },
          image: { UID: 8 },
          icon: { UID: 0 },
        },
        { "NS.relative": { UID: 9 } },
        { "NS.relative": { UID: 10 } },
        " Fictional title\u0000 ",
        "Fictional summary",
        "Example Test",
        { imageType: 1 },
        "https://example.test/original",
        "https://example.test/final",
      ],
    },
  ];
}

describe("BlueBubbles link preview parser", () => {
  it("resolves NSKeyedArchive UID references without preserving raw data", () => {
    expect(parseBlueBubblesLinkPreviews(archive())).toEqual([
      {
        source: "bluebubbles",
        url: "https://example.test/final",
        originalUrl: "https://example.test/original",
        title: "Fictional title",
        summary: "Fictional summary",
        siteName: "Example Test",
        imageAvailable: true,
        iconAvailable: false,
      },
    ]);
  });

  it("rejects malformed archives and non-http URLs", () => {
    expect(parseBlueBubblesLinkPreviews([{ $objects: [] }])).toEqual([]);
    const value = archive();
    value[0]!.$objects[9] = "file:///private/original";
    value[0]!.$objects[10] = "file:///private/example";
    expect(parseBlueBubblesLinkPreviews(value)).toEqual([]);
  });
});

describe("Open Graph public network guard", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "file:///tmp/a",
  ])("blocks unsafe URL %s", async (url) => {
    await expect(
      new OpenGraphClient().fetch(url, 1_000),
    ).rejects.toBeInstanceOf(OpenGraphFetchError);
  });
});

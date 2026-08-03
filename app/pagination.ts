import { z } from "zod";

import { ApplicationError } from "./errors.js";

const cursorSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export interface PageCursor {
  timestamp: Date;
  id: string;
}

export function encodeCursor(
  cursor: { timestamp: string; id: string } | undefined,
): string | null {
  if (cursor === undefined) {
    return null;
  }

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): PageCursor | null {
  if (value === undefined) {
    return null;
  }

  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return { timestamp: new Date(parsed.timestamp), id: parsed.id };
  } catch (error) {
    throw new ApplicationError(
      "INVALID_CURSOR",
      "The pagination cursor is invalid.",
      400,
      {
        cause: error,
      },
    );
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const version = "v1";

export class SettingsCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [
      version,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): string {
    const [encodedVersion, encodedIv, encodedTag, encodedPayload] =
      value.split(".");
    if (
      encodedVersion !== version ||
      encodedIv === undefined ||
      encodedTag === undefined ||
      encodedPayload === undefined
    ) {
      throw new Error("The stored settings secret has an unsupported format.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedPayload, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

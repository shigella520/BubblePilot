import { hashPassword } from "./security.js";

if (process.stdin.isTTY) {
  throw new Error(
    "Read the password from standard input, for example: printf '%s' \"$BUBBLEPILOT_PLAIN_PASSWORD\" | pnpm auth:hash",
  );
}

let password = "";
for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
  password += chunk.toString();
}
password = password.replace(/\r?\n$/u, "");
if (password.length === 0) {
  throw new Error("The password must not be empty.");
}

process.stdout.write(`${await hashPassword(password)}\n`);

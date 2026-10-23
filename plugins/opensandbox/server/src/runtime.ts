import { z } from "zod";

const name = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const capabilities = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal("bubblepilot-python-3.12-v1"),
    python: z.literal("3.12"),
    commands: z.array(name).max(64),
    pythonModules: z.array(name).max(32),
    limits: z.array(name).max(16),
  })
  .strict();
export type RuntimeInfo = z.infer<typeof capabilities> | { id: "unknown" };
export function parseRuntime(text: string): RuntimeInfo {
  if (Buffer.byteLength(text) > 8192) return { id: "unknown" };
  try {
    const value = capabilities.safeParse(JSON.parse(text));
    return value.success ? value.data : { id: "unknown" };
  } catch {
    return { id: "unknown" };
  }
}
// Read once before exposing the workspace to the model. Never follow a symlink,
// block on a device/FIFO, or include arbitrary file contents in the tool result.
const initialize = `import os, stat
os.makedirs('/workspace', exist_ok=True)
try:
    fd = os.open('/opt/bubblepilot/capabilities.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise ValueError('not a regular file')
        data = f.read(8193)
    if len(data) > 8192:
        raise ValueError('too large')
    print(data.decode('utf-8'))
except (OSError, ValueError):
    print('{}')
`;
export const initializeWorkspaceCommand =
  "python -c '" + initialize.replaceAll("'", "'\\''") + "'";

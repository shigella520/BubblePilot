import { createHash } from "node:crypto";
import { z } from "zod";

export const imageExportProtocol = "io.bubblepilot/image-export";
export const imageExportMaxBytes = 8 * 1024 * 1024;
export const imageExportPath = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path.startsWith("/workspace/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .slice(11)
        .split("/")
        .every((p) => p && p !== "." && p !== ".."),
  );
export class ImageExportError extends Error {}
export const imageExportErrors = new Set([
  "image_path_denied",
  "image_not_found",
  "image_not_regular",
  "image_too_large",
  "image_invalid",
  "image_animated",
  "image_pixels_exceeded",
  "image_changed",
  "image_export_failed",
  "image_export_unsupported",
  "prepare_sandbox_required",
]);
export async function readImageResponse(
  response: Response,
  signal: AbortSignal,
) {
  if (!response.ok) throw new ImageExportError("image_export_failed");
  const size = Number(response.headers.get("content-length"));
  const hash = response.headers.get("x-content-sha256");
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > imageExportMaxBytes ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash)
  ) {
    await response.body?.cancel();
    throw new ImageExportError("image_export_failed");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = (
    response.body as ReadableStream<Uint8Array> | null
  )?.getReader();
  if (!reader) throw new ImageExportError("image_export_failed");
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > size) throw new ImageExportError("image_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = Buffer.concat(chunks);
  if (
    bytes !== size ||
    createHash("sha256").update(data).digest("hex") !== hash
  )
    throw new ImageExportError("image_export_failed");
  return data;
}

export const imageExportHelper = String.raw`import os,sys,json,base64,stat,io,hashlib,hmac
from http.server import HTTPServer,BaseHTTPRequestHandler
from PIL import Image
p=json.loads(base64.b64decode(sys.argv[1])); fds=[]
try:
 path=p['path']
 if not path.startswith('/workspace/') or '\\' in path: raise ValueError('image_path_denied')
 parts=path[11:].split('/')
 if any(x in ('','.','..') for x in parts): raise ValueError('image_path_denied')
 parent=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(parent)
 for part in parts[:-1]:
  parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent); fds.append(parent)
 fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent); fds.append(fd)
 before=os.fstat(fd)
 if not stat.S_ISREG(before.st_mode): raise ValueError('image_not_regular')
 if before.st_size>8388608: raise ValueError('image_too_large')
 with os.fdopen(os.dup(fd),'rb') as f: data=f.read(8388609)
 after=os.fstat(fd)
 if len(data)>8388608: raise ValueError('image_too_large')
 if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ValueError('image_changed')
 with Image.open(io.BytesIO(data)) as im:
  if im.format!='PNG': raise ValueError('image_invalid')
  if im.width*im.height>16000000 or max(im.size)>8192: raise ValueError('image_pixels_exceeded')
  if getattr(im,'n_frames',1)!=1 or getattr(im,'is_animated',False): raise ValueError('image_animated')
  im.verify()
 with Image.open(io.BytesIO(data)) as im: im.load()
except Exception as error:
 allowed={'image_path_denied','image_not_regular','image_too_large','image_changed','image_invalid','image_pixels_exceeded','image_animated'}
 code=str(error) if isinstance(error,ValueError) and str(error) in allowed else ('image_not_found' if isinstance(error,FileNotFoundError) else 'image_invalid')
 print('IMAGE_ERROR:'+code,flush=True); sys.exit(1)
finally:
 for fd in reversed(fds): os.close(fd)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.connection.settimeout(5)
  if not hmac.compare_digest(self.headers.get('X-Transfer-Token',''),p['token']):
   self.send_error(403); return
  self.send_response(200); self.send_header('Content-Type','image/png'); self.send_header('Content-Length',str(len(data))); self.send_header('X-Content-SHA256',hashlib.sha256(data).hexdigest()); self.end_headers(); self.wfile.write(data)
server=HTTPServer(('0.0.0.0',p['port']),Handler); server.timeout=p['seconds']
print('IMAGE_READY',flush=True)
server.handle_request(); server.server_close()
`;
export function imageExportCommand(input: {
  path: string;
  port: number;
  token: string;
  seconds: number;
}) {
  return `python3 -I -c 'import base64;exec(base64.b64decode("${Buffer.from(imageExportHelper).toString("base64")}"))' '${Buffer.from(JSON.stringify(input)).toString("base64")}'`;
}

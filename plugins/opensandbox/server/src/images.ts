import { z } from "zod";

export const imagePreviewLimits = {
  fileBytes: 20 * 1024 * 1024,
  pixels: 40_000_000,
  edge: 2048,
  bytes: 512 * 1024,
} as const;

// Descriptor traversal is identical to the text helper. Decode only a bounded
// in-memory snapshot, never reopen the model-supplied pathname after checking it.
export const imageHelper = `import os,sys,json,base64,stat,io,warnings
p=json.loads(base64.b64decode(sys.argv[1]))
fds=[]
try:
 parts=p['path'].split('/')
 if parts[:2]!=['','workspace'] or len(parts)<3 or any(x in ('','.','..') or '\\x00' in x for x in parts[2:]):
  raise ValueError('path_outside_workspace')
 d=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(d)
 for part in parts[2:-1]:
  d=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d); fds.append(d)
 f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d); fds.append(f)
 info=os.fstat(f)
 if not stat.S_ISREG(info.st_mode): raise ValueError('regular_file_required')
 if info.st_size>${imagePreviewLimits.fileBytes}: raise ValueError('image_too_large')
 chunks=[]; size=0
 while True:
  chunk=os.read(f,min(65536,${imagePreviewLimits.fileBytes}+1-size))
  if not chunk: break
  chunks.append(chunk); size+=len(chunk)
  if size>${imagePreviewLimits.fileBytes}: raise ValueError('image_too_large')
 from PIL import Image,ImageOps
 Image.MAX_IMAGE_PIXELS=${imagePreviewLimits.pixels}
 warnings.simplefilter('error',Image.DecompressionBombWarning)
 source=Image.open(io.BytesIO(b''.join(chunks)))
 if source.format not in ('PNG','JPEG','WEBP','GIF'): raise ValueError('unsupported_image_type')
 if source.width*source.height>${imagePreviewLimits.pixels}: raise ValueError('image_pixel_limit')
 width,height=source.size; frames=getattr(source,'n_frames',1)
 source.seek(0); source.draft('RGB',(${imagePreviewLimits.edge},${imagePreviewLimits.edge})); source.load()
 source.thumbnail((${imagePreviewLimits.edge},${imagePreviewLimits.edge}),Image.Resampling.LANCZOS)
 image=ImageOps.exif_transpose(source).convert('RGBA')
 out=io.BytesIO(); image.save(out,format='PNG'); mime='image/png'; background=False
 if out.tell()>${imagePreviewLimits.bytes}:
  rgb=Image.new('RGB',image.size,'white'); rgb.paste(image,mask=image.getchannel('A')); background=True
  for quality in (90,80,70):
   out=io.BytesIO(); rgb.save(out,format='JPEG',quality=quality); mime='image/jpeg'
   if out.tell()<=${imagePreviewLimits.bytes}: break
 if out.tell()>${imagePreviewLimits.bytes}: raise ValueError('preview_too_large')
 print(json.dumps({'status':'viewed','data':base64.b64encode(out.getvalue()).decode('ascii'),'mimeType':mime,'width':image.width,'height':image.height,'sourceWidth':width,'sourceHeight':height,'sourceBytes':size,'bytes':out.tell(),'transformed':True,'firstFrameOnly':frames>1,'whiteBackground':background}))
except ImportError:
 print(json.dumps({'status':'image_dependency_unavailable'}))
except ValueError as e:
 allowed=('path_outside_workspace','regular_file_required','image_too_large','unsupported_image_type','image_pixel_limit','preview_too_large')
 print(json.dumps({'status':str(e) if str(e) in allowed else 'invalid_image'}))
except Exception:
 print(json.dumps({'status':'image_unavailable_or_invalid'}))
finally:
 for f in reversed(fds): os.close(f)
`;

export function imageCommand(path: string) {
  const source = Buffer.from(imageHelper).toString("base64");
  const payload = Buffer.from(JSON.stringify({ path })).toString("base64");
  // -I permits the image's pinned site-packages but excludes cwd/PYTHONPATH.
  return `/usr/local/bin/python3 -I -c 'import base64;exec(base64.b64decode("${source}"))' '${payload}'`;
}

const previewSchema = z.object({
  status: z.literal("viewed"),
  data: z.string().max(Math.ceil(imagePreviewLimits.bytes / 3) * 4),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive().max(imagePreviewLimits.edge),
  height: z.number().int().positive().max(imagePreviewLimits.edge),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  sourceBytes: z.number().int().nonnegative().max(imagePreviewLimits.fileBytes),
  bytes: z.number().int().positive().max(imagePreviewLimits.bytes),
  transformed: z.boolean(),
  firstFrameOnly: z.boolean(),
  whiteBackground: z.boolean(),
});
export function imageReply(stdout: string) {
  const value: unknown = JSON.parse(stdout);
  const parsed = previewSchema.safeParse(value);
  if (!parsed.success) {
    const status =
      value &&
      typeof value === "object" &&
      "status" in value &&
      typeof value.status === "string" &&
      [
        "path_outside_workspace",
        "regular_file_required",
        "image_too_large",
        "unsupported_image_type",
        "image_pixel_limit",
        "preview_too_large",
        "image_dependency_unavailable",
        "invalid_image",
        "image_unavailable_or_invalid",
      ].includes(value.status)
        ? value.status
        : "invalid_image_result";
    return {
      isError: true,
      structuredContent: { status },
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status,
            guidance:
              "Use a valid regular PNG/JPEG/WebP/GIF file in /workspace. Crop or resize an oversized image before retrying.",
          }),
        },
      ],
    };
  }
  const { data, mimeType, ...metadata } = parsed.data;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data || bytes.length !== metadata.bytes)
    throw new Error("invalid_image_result");
  return {
    isError: false,
    structuredContent: metadata,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...metadata,
          notice:
            "Sandbox image preview; transformations, first-frame and white-background limits apply. Tool success is not proof of model recognition.",
        }),
      },
      { type: "image" as const, mimeType, data },
    ],
  };
}

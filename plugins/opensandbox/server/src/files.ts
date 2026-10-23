// The helper never interpolates user values into shell or Python source. Every
// component is opened relative to a held directory descriptor with O_NOFOLLOW.
export const fileHelper = `import os,sys,json,base64,stat,codecs
p=json.loads(base64.b64decode(sys.argv[1]))
parts=p['path'].split('/')
if parts[:2]!=['','workspace'] or len(parts)<3 or any(x in ('','.','..') for x in parts[2:]):
 raise ValueError('path_outside_workspace')
fds=[]
try:
 d=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(d)
 for part in parts[2:-1]:
  d=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=d); fds.append(d)
 flags=os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_RDONLY if p['op']=='read' else os.O_WRONLY|os.O_CREAT)
 f=os.open(parts[-1],flags,0o600,dir_fd=d); fds.append(f)
 if not stat.S_ISREG(os.fstat(f).st_mode): raise ValueError('regular_file_required')
 if p['op']=='read':
  os.lseek(f,p['offset'],os.SEEK_SET)
  data=os.read(f,p['length'])
  eof=p['offset']+len(data)>=os.fstat(f).st_size
  decoder=codecs.getincrementaldecoder('utf-8')('strict')
  text=decoder.decode(data,final=eof)
  used=len(data)-len(decoder.getstate()[0])
  result={'status':'read','text':text,'nextOffset':p['offset']+used,'eof':eof}
 else:
  data=p['text'].encode('utf-8')
  if len(data)>65536: raise ValueError('file_input_limit')
  os.ftruncate(f,0)
  total=0
  while total<len(data): total+=os.write(f,data[total:])
  result={'status':'written','bytes':total}
 print(json.dumps(result,ensure_ascii=True))
except (OSError,ValueError,UnicodeError):
 print(json.dumps({'status':'file_unavailable_or_invalid_utf8'})); sys.exit(1)
finally:
 for f in reversed(fds): os.close(f)
`;
export function fileCommand(
  input:
    | { op: "read"; path: string; offset: number; length: number }
    | { op: "write"; path: string; text: string },
) {
  const source = Buffer.from(fileHelper).toString("base64");
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  return `/usr/local/bin/python3 -I -S -c 'import base64;exec(base64.b64decode("${source}"))' '${payload}'`;
}

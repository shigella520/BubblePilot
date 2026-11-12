// Runs once inside the sandbox. Binary bytes travel over HTTP, never shell/MCP
// arguments. Held descriptors and O_NOFOLLOW protect against directory races.
export const attachmentHelper = String.raw`import os,sys,json,base64,hashlib,hmac,stat,zipfile,tarfile,gzip,socket
from http.server import HTTPServer,BaseHTTPRequestHandler
from socketserver import TCPServer
p=json.loads(base64.b64decode(sys.argv[1]))
fds=[]
def directory(name,parent):
 try: os.mkdir(name,0o700,dir_fd=parent)
 except FileExistsError: pass
 d=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent); fds.append(d); return d
root=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); fds.append(root)
base=directory('attachments',root)
os.mkdir(p['id'],0o700,dir_fd=base)
d=os.open(p['id'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base); fds.append(d)
f=os.open('.partial',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d); fds.append(f)
def write_all(fd,data):
 while data:
  n=os.write(fd,data); data=data[n:]
expanded=0
count=0
def extract_member(name,source,out):
 global expanded,count
 parts=name.replace('\\','/').split('/')
 if name.startswith('/') or any(x in ('','.','..') or ':' in x for x in parts): raise ValueError('archive_path_denied')
 count+=1
 if count>p['limits']['expandedFiles']: raise ValueError('archive_file_limit')
 parent=out
 for part in parts[:-1]: parent=directory(part,parent)
 fd=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent); fds.append(fd)
 while True:
  data=source.read(65536)
  if not data: break
  expanded+=len(data)
  if expanded>p['limits']['expandedMiB']*1024*1024: raise ValueError('archive_byte_limit')
  write_all(fd,data)
def extract():
 global expanded,count
 name=p['filename'].lower()
 if name.endswith('.xlsx'):
  os.lseek(f,0,os.SEEK_SET)
  with os.fdopen(os.dup(f),'rb') as src:
   with zipfile.ZipFile(src) as archive:
    names=archive.namelist()
    if '[Content_Types].xml' not in names or 'xl/workbook.xml' not in names or any(x.lower().endswith('.bin') for x in names): raise ValueError('xlsx_invalid_or_macros')
    total=0
    if len(names)>p['limits']['expandedFiles']: raise ValueError('archive_file_limit')
    for item in archive.infolist():
     if item.flag_bits&1 or stat.S_IFMT(item.external_attr>>16) not in (0,stat.S_IFREG,stat.S_IFDIR): raise ValueError('archive_type_denied')
     if item.is_dir(): continue
     with archive.open(item) as content:
      while True:
       data=content.read(65536)
       if not data: break
       total+=len(data)
       if total>p['limits']['expandedMiB']*1024*1024: raise ValueError('archive_byte_limit')
  expanded+=total; count+=len(names)
  return None
 if not name.endswith(('.zip','.tar','.tar.gz','.tgz','.gz')): return None
 out=directory('expanded',d)
 os.lseek(f,0,os.SEEK_SET)
 with os.fdopen(os.dup(f),'rb') as src:
  if name.endswith('.zip'):
   with zipfile.ZipFile(src) as archive:
    for item in archive.infolist():
     mode=item.external_attr>>16
     if item.flag_bits&1 or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)): raise ValueError('archive_type_denied')
     if item.is_dir():
      parts=item.filename.rstrip('/').replace('\\','/').split('/')
      if any(x in ('','.','..') or ':' in x for x in parts): raise ValueError('archive_path_denied')
      continue
     with archive.open(item) as content: extract_member(item.filename,content,out)
  elif name.endswith(('.tar','.tar.gz','.tgz')):
   with tarfile.open(fileobj=src,mode='r|*') as archive:
    for item in archive:
     if item.isdir():
      parts=item.name.rstrip('/').replace('\\','/').split('/')
      if any(x in ('','.','..') or ':' in x for x in parts): raise ValueError('archive_path_denied')
      continue
     if not item.isfile(): raise ValueError('archive_type_denied')
     with archive.extractfile(item) as content: extract_member(item.name,content,out)
  else:
   with gzip.GzipFile(fileobj=src) as content: extract_member('content',content,out)
 return '/workspace/attachments/'+p['id']+'/expanded'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  try:
   if not hmac.compare_digest(self.headers.get('X-Transfer-Token',''),p['token']): raise ValueError('unauthorized')
   if self.headers.get('Transfer-Encoding') or int(self.headers.get('Content-Length','-1'))!=p['size']: raise ValueError('invalid_length')
   self.connection.settimeout(5)
   remaining=p['size']; h=hashlib.sha256()
   while remaining:
    data=self.rfile.read(min(65536,remaining))
    if not data: raise ValueError('incomplete_body')
    remaining-=len(data); h.update(data); write_all(f,data)
   if h.hexdigest()!=p['sha256']: raise ValueError('hash_mismatch')
   os.fsync(f)
   expandedPath=extract()
   # Revalidate held directory identity. Rename within held dir never follows
   # a hostile destination link; UUID directory prevents overwriting old imports.
   original=os.stat('.partial',dir_fd=d,follow_symlinks=False)
   if original.st_ino!=os.fstat(f).st_ino or not stat.S_ISREG(original.st_mode): raise ValueError('staging_changed')
   check=os.open(p['id'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base)
   try:
    if os.fstat(check).st_ino!=os.fstat(d).st_ino: raise ValueError('directory_changed')
   finally: os.close(check)
   os.rename('.partial',p['filename'],src_dir_fd=d,dst_dir_fd=d)
   result={'status':'imported','sandbox_path':'/workspace/attachments/'+p['id']+'/'+p['filename'],'size':p['size'],'sha256':h.hexdigest(),'expandedBytes':expanded,'expandedFiles':count}
   if expandedPath: result['expandedPath']=expandedPath
   data=json.dumps(result).encode(); self.send_response(200); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
  except Exception as error:
   allowed={'unauthorized','invalid_length','incomplete_body','hash_mismatch','archive_path_denied','archive_type_denied','archive_file_limit','archive_byte_limit','xlsx_invalid_or_macros','staging_changed','directory_changed'}
   code=str(error) if isinstance(error,ValueError) and str(error) in allowed else 'file_import_failed'
   data=json.dumps({'error':code}).encode()
   self.send_response(422); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
class Server(HTTPServer):
 def server_bind(self):
  TCPServer.server_bind(self)
  self.server_name='sandbox'; self.server_port=self.server_address[1]
server=Server(('0.0.0.0',p['port']),Handler); server.timeout=p.get('acceptTimeoutSeconds',40)
print('ATTACHMENT_READY',flush=True)
try: server.handle_request()
finally:
 server.server_close()
 for fd in reversed(fds): os.close(fd)
`;
export function attachmentCommand(input: Record<string, unknown>) {
  return `/usr/local/bin/python3 -I -S -u -c 'import base64;exec(base64.b64decode("${Buffer.from(attachmentHelper).toString("base64")}"))' '${Buffer.from(JSON.stringify(input)).toString("base64")}'`;
}

// A soft usage check, not a kernel disk quota; no symlink traversal.
const workspaceUsage = String.raw`import os,stat
size=0
seen=set()
count=0
for root in ['/workspace','/tmp']:
 if not stat.S_ISDIR(os.stat(root,follow_symlinks=False).st_mode): raise ValueError('invalid_root')
 for base,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   count+=1
   if count>20000: raise ValueError('entry_limit')
   try: s=os.stat(os.path.join(base,name),follow_symlinks=False)
   except FileNotFoundError: continue
   key=(s.st_dev,s.st_ino)
   if key not in seen: size+=s.st_blocks*512; seen.add(key)
   if size>268435456: raise ValueError('space_limit')
print((size+1023)//1024)
`;
export const workspaceUsageCommand = `/usr/local/bin/python3 -I -S -c 'import base64;exec(base64.b64decode("${Buffer.from(workspaceUsage).toString("base64")}"))'`;

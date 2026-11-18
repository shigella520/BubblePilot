# Offline image helper probe: all files and image contents are fictional.
import os,json,base64,subprocess,time
from PIL import Image,ImageDraw
os.makedirs('/workspace',exist_ok=True)
image=Image.new('RGB',(3200,1800),'white')
draw=ImageDraw.Draw(image)
for i in range(12):
 draw.rectangle((100+i*230,1600-i*100,230+i*230,1600),fill=(30,100,180))
image.save('/workspace/chart.png')
Image.new('RGBA',(800,600),(255,0,0,80)).save('/workspace/transparent.png')
Image.new('RGB',(10,10),'red').save('/workspace/animated.gif',save_all=True,append_images=[Image.new('RGB',(10,10),'blue')],duration=100,loop=0)
Image.new('RGB',(10000,4000),'white').save('/workspace/large.jpg')
open('/workspace/bad.png','wb').write(b'not an image')
os.symlink('/etc/passwd','/workspace/link')
os.symlink('/etc','/workspace/dir')
os.mkfifo('/workspace/pipe')
for name in ['chart.png','transparent.png','animated.gif','large.jpg','bad.png','link','dir/passwd','../etc/passwd','pipe']:
 started=time.monotonic()
 p=subprocess.run(['python','-I',helper_path,base64.b64encode(json.dumps({'path':'/workspace/'+name}).encode()).decode()],capture_output=True,timeout=30)
 result=json.loads(p.stdout)
 data=result.pop('data',None)
 if data:
  assert len(p.stdout)<1024*1024
  assert len(base64.b64decode(data))<=512*1024
  assert max(result['width'],result['height'])<=2048
 assert (result['status']=='viewed')==(name in ['chart.png','transparent.png','animated.gif','large.jpg'])
 print(json.dumps({'fixture':name,'seconds':round(time.monotonic()-started,3),'stdoutBytes':len(p.stdout),**result}))

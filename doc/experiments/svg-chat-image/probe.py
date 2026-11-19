"""Disposable feasibility probe; not a production export service."""
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import resource
import re
import random
import stat
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image
from xml.etree import ElementTree

ROOT = Path('/workspace')
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000
results = {'renderer': [], 'safety': []}


def preflight(source, width, height):
    # Deliberately narrow experimental SVG subset, not a complete sanitizer.
    if len(source.encode()) > 1024 * 1024 or width * height > MAX_PIXELS:
        raise ValueError('render_budget')
    if width < 1 or height < 1 or width > 8192 or height > 8192:
        raise ValueError('render_dimensions')
    if '<!DOCTYPE' in source.upper() or '<!ENTITY' in source.upper():
        raise ValueError('xml_declaration_denied')
    tree = ElementTree.fromstring(source)
    nodes = list(tree.iter())
    if len(nodes) > 50000:
        raise ValueError('node_budget')
    for node in nodes:
        tag = node.tag.split('}')[-1]
        if tag in ('script', 'foreignObject', 'style'):
            raise ValueError('unsupported_element')
        for key, value in node.attrib.items():
            if key.split('}')[-1].lower().startswith('on'):
                raise ValueError('event_handler_denied')
            if key.split('}')[-1] == 'href' and not value.startswith('#'):
                raise ValueError('external_resource_denied')
            if 'url(' in value.lower() and not re.fullmatch(r'url\(#[A-Za-z0-9_-]+\)', value):
                raise ValueError('external_resource_denied')


def render(name, source, extra=()):
    src, dest = ROOT / (name + '.svg'), ROOT / (name + '.png')
    src.write_text(source)
    start = time.monotonic()
    completed = subprocess.run(['resvg', *extra, str(src), str(dest)],
                               capture_output=True, timeout=10)
    item = {'name': name, 'seconds': round(time.monotonic() - start, 3),
            'returncode': completed.returncode,
            'stderr': completed.stderr.decode(errors='replace')[:1000]}
    if dest.exists():
        with Image.open(dest) as im:
            im.load()
            item.update(bytes=dest.stat().st_size, dimensions=im.size,
                        alpha_corner=im.convert('RGBA').getpixel((0, 0))[3])
    results['renderer'].append(item)
    return dest


def snapshot(path):
    # Open each component relative to held descriptors; never follow symlinks.
    if not path.startswith('/workspace/'):
        raise ValueError('outside_workspace')
    parts = path[len('/workspace/'):].split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('invalid_path')
    descriptors = []
    try:
        parent = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(parent)
        for part in parts[:-1]:
            parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=parent)
            descriptors.append(parent)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=parent)
        descriptors.append(fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('not_regular_file')
        if before.st_size > MAX_BYTES:
            raise ValueError('byte_limit')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(MAX_BYTES + 1)
        after = os.fstat(fd)
        if len(data) > MAX_BYTES:
            raise ValueError('byte_limit')
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('file_changed')
        with Image.open(io.BytesIO(data)) as im:
            if im.format != 'PNG' or im.width * im.height > MAX_PIXELS:
                raise ValueError('invalid_image')
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            im.load()
        return data
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def denied(name, path):
    try:
        snapshot(path)
    except (ValueError, OSError) as error:
        results['safety'].append({'name': name, 'rejected': True,
                                  'reason': type(error).__name__ + ': ' + str(error)[:120]})
    else:
        raise AssertionError(name + ' was accepted')


source = Path('/probe/chart.svg').read_text()
preflight(source, 2400, 1520)
for i in range(4):
    render('chart-' + str(i), source)
render('chart-2x', source, ('--width', '2400'))
assert all(x['returncode'] == 0 for x in results['renderer'])
assert results['renderer'][0]['alpha_corner'] == 0
assert results['renderer'][-1]['dimensions'] == (2400, 1520)
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">{}</svg>'
foreign = render('foreign-object', svg.format('<foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>'))
with Image.open(foreign) as im:
    results['foreignObject_is_blank'] = im.getbbox() is None
# resvg is not a resource security boundary: test what it reads by itself.
Image.new('RGB', (20, 20), 'red').save('/workspace/resource.png')
for name, href in [('relative-resource', 'resource.png'),
                   ('file-resource', 'file:///workspace/resource.png'),
                   ('http-resource', 'http://127.0.0.1:9/resource.png')]:
    path = render(name, svg.format(f'<image href="{href}" width="100" height="100"/>'))
    with Image.open(path) as im:
        results[name + '_visible'] = im.getbbox() is not None
entity = '<!DOCTYPE svg [<!ENTITY ext SYSTEM "file:///etc/hostname">]>' + svg.format('<text y="20">&ext;</text>')
render('external-entity', entity)
results['preflight_rejections'] = []
for name, candidate, width, height in [
        ('foreignObject', svg.format('<foreignObject/>'), 100, 100),
        ('external_resource', svg.format('<image href="resource.png"/>'), 100, 100),
        ('css_url', svg.format('<rect fill="url(http://example.test/a)"/>'), 100, 100),
        ('xml_entity', entity, 100, 100),
        ('oversized_dimensions', source, 100000, 100000),
        ('oversized_source', ' ' * (1024 * 1024 + 1), 100, 100)]:
    try:
        preflight(candidate, width, height)
    except ValueError:
        results['preflight_rejections'].append(name)
    else:
        raise AssertionError('preflight accepted ' + name)

payload = snapshot('/workspace/chart-2x.png')
Image.frombytes('RGB', (1024, 1024), random.Random(42).randbytes(1024 * 1024 * 3)).save('/workspace/large.png')
large_payload = snapshot('/workspace/large.png')
assert len(large_payload) > 1024 * 1024
results['large_png_bytes'] = len(large_payload)
results['snapshot_sha256'] = hashlib.sha256(payload).hexdigest()
results['snapshot_bytes'] = len(payload)
Path('/workspace/link.png').symlink_to('/workspace/chart-2x.png')
Path('/workspace/dirlink').symlink_to('/workspace', target_is_directory=True)
os.mkfifo('/workspace/fifo.png')
Path('/workspace/fake.png').write_text('not a PNG')
Path('/workspace/truncated.png').write_bytes(payload[:100])
with open('/workspace/oversize.png', 'wb') as f:
    f.truncate(MAX_BYTES + 1)
Image.new('1', (5000, 4000)).save('/workspace/too-many-pixels.png')
for name, path in [('traversal', '/workspace/../etc/passwd'),
                   ('outside', '/etc/passwd'), ('symlink', '/workspace/link.png'),
                   ('parent_symlink', '/workspace/dirlink/chart-2x.png'),
                   ('fifo', '/workspace/fifo.png'), ('fake', '/workspace/fake.png'),
                   ('truncated', '/workspace/truncated.png'),
                   ('bytes', '/workspace/oversize.png'),
                   ('pixels', '/workspace/too-many-pixels.png')]:
    denied(name, path)
# Freeze bytes before transport. Later mutations cannot change this export.
Path('/workspace/chart-2x.png').write_bytes(b'changed after preparation')
assert hashlib.sha256(payload).hexdigest() == results['snapshot_sha256']
results['snapshot_survives_source_mutation'] = True
results['child_peak_rss_kib'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
results['versions'] = {
    'resvg': subprocess.check_output(['resvg', '--version'], text=True).strip(),
    'font_sha256': hashlib.sha256(Path('/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf').read_bytes()).hexdigest(),
    'pillow': Image.__version__,
}
if os.environ.get('PROBE_RENDER_ONLY') == '1':
    print(json.dumps(results, ensure_ascii=False))
    raise SystemExit(0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('X-Transfer-Token', ''),
                                   os.environ['PROBE_TOKEN']):
            self.send_error(403)
            return
        if self.path == '/results':
            data = json.dumps(results, ensure_ascii=False).encode()
        elif self.path == '/large':
            data = large_payload
        elif self.path in ('/image', '/truncated', '/bad-hash', '/oversize', '/slow'):
            data = payload
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(MAX_BYTES + 1 if self.path == '/oversize' else len(data)))
        self.send_header('X-Content-SHA256', '0' * 64 if self.path == '/bad-hash' else hashlib.sha256(data).hexdigest())
        self.end_headers()
        try:
            if self.path == '/slow':
                self.wfile.write(data[:65536])
                self.wfile.flush()
                time.sleep(1)
                self.wfile.write(data[65536:])
            else:
                self.wfile.write(data[:100] if self.path == '/truncated' else data)
        except (BrokenPipeError, ConnectionResetError):
            pass


print('READY', flush=True)
ThreadingHTTPServer(('0.0.0.0', 47832), Handler).serve_forever()

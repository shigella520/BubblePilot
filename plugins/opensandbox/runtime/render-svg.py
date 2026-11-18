#!/usr/local/bin/python3 -I
"""Render a deliberately limited native SVG subset; never fetch SVG resources."""
import argparse
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
from xml.etree import ElementTree as ET
from PIL import Image

FONT = '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf'
TAGS = set('svg g defs title desc rect circle ellipse line polyline polygon path text tspan linearGradient radialGradient stop clipPath mask filter feDropShadow feGaussianBlur feOffset feBlend feComposite feFlood feMerge feMergeNode feColorMatrix marker use symbol'.split())
ATTRS = set('id x y x1 y1 x2 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing word-spacing dx dy rotate textLength lengthAdjust offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits filter filterUnits primitiveUnits in in2 result stdDeviation flood-color flood-opacity mode operator k1 k2 k3 k4 type values color-interpolation-filters marker-start marker-mid marker-end markerWidth markerHeight refX refY orient markerUnits href'.split())


def components(path):
    if not path.startswith('/workspace/') or '\\' in path or '\0' in path:
        raise ValueError('svg_path_denied')
    parts = path[11:].split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('svg_path_denied')
    return parts


def parent_fd(path):
    parts = components(path)
    fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def render(source, destination, width=None):
    parent, name = parent_fd(source)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('svg_not_regular')
            data = stream.read(1048577)
    finally:
        os.close(parent)
    if len(data) > 1048576:
        raise ValueError('svg_source_too_large')
    # Decode UTF-8 before checking declarations so UTF-16 cannot bypass checks.
    text = data.decode('utf-8-sig')
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('svg_entities_unsupported')
    root = ET.fromstring(text)
    if root.tag != '{http://www.w3.org/2000/svg}svg':
        raise ValueError('svg_namespace_required')
    nodes = list(root.iter())
    if len(nodes) > 5000:
        raise ValueError('svg_complexity_exceeded')
    for element in nodes:
        if not element.tag.startswith('{http://www.w3.org/2000/svg}') or element.tag.split('}')[-1] not in TAGS:
            raise ValueError('svg_element_unsupported')
        for key, value in element.attrib.items():
            local = key.split('}')[-1]
            if local not in ATTRS or ('}' in key and key != '{http://www.w3.org/1999/xlink}href'):
                raise ValueError('svg_attribute_unsupported')
            if '\\' in value or any(ord(c) < 32 for c in value):
                raise ValueError('svg_attribute_unsupported')
            if local == 'href' and not re.fullmatch(r'#[A-Za-z_][A-Za-z0-9_.-]*', value):
                raise ValueError('svg_external_resource_denied')
            if 'url' in value.lower() and not re.fullmatch(r'url\(#[A-Za-z_][A-Za-z0-9_.-]*\)', value):
                raise ValueError('svg_external_resource_denied')
            if local in ('font-family',):
                element.set(key, 'Noto Sans CJK SC')
    box = root.get('viewBox', '').replace(',', ' ').split()
    if len(box) == 4:
        _, _, w, h = map(float, box)
    else:
        w = float(root.get('width', '0').removesuffix('px'))
        h = float(root.get('height', '0').removesuffix('px'))
    if not math.isfinite(w) or not math.isfinite(h) or min(w, h) <= 0:
        raise ValueError('svg_dimensions_invalid')
    out_w = math.ceil(w) if width is None else width
    out_h = math.ceil(out_w * h / w)
    if min(out_w, out_h) < 1 or max(out_w, out_h) > 8192 or out_w * out_h > 16000000:
        raise ValueError('svg_dimensions_exceeded')
    root.set('width', str(out_w)); root.set('height', str(out_h))
    # Private temp directory and fully parsed/re-serialized input detach rendering
    # from mutable source files. The subset has no external resource references.
    with tempfile.TemporaryDirectory(prefix='bp-svg-') as temp:
        src, dst = Path(temp) / 'source.svg', Path(temp) / 'result.png'
        src.write_bytes(ET.tostring(root))
        command = ['/usr/local/bin/resvg', '--skip-system-fonts', '--use-font-file', FONT,
                   '--font-family', 'Noto Sans CJK SC', str(src), str(dst)]
        completed = subprocess.run(command, capture_output=True, timeout=10)
        if completed.returncode:
            raise ValueError('svg_render_failed')
        with dst.open('rb') as file:
            png = file.read(8388609)
        if len(png) > 8388608:
            raise ValueError('png_too_large')
        with Image.open(io.BytesIO(png)) as image:
            image.load()
            if image.size != (out_w, out_h):
                raise ValueError('png_dimensions_invalid')
    parent, name = parent_fd(destination)
    temporary = '.bp-render-' + os.urandom(16).hex()
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(png)
        # Replacing a link removes the link rather than following it.
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass
        os.close(parent)
    return {'status': 'rendered', 'path': destination, 'width': out_w, 'height': out_h, 'bytes': len(png)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Render native SVG to PNG in /workspace. No HTML or external resources.')
    parser.add_argument('source'); parser.add_argument('destination'); parser.add_argument('--width', type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(render(args.source, args.destination, args.width)))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith(('svg_', 'png_')) else 'svg_render_failed'
        print(json.dumps({'status': 'failed', 'code': code, 'guidance': 'Use native SVG shapes/text, no HTML or external resources, and stay within size and time limits.'}))
        raise SystemExit(1)

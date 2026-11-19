"""Offline tests of the actual renderer under the runtime's resource limits."""
from pathlib import Path
import json
import subprocess
from PIL import Image

root = Path('/workspace')
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect x="20" y="20" width="560" height="200" rx="20" fill="#e3f5ef"/><text x="40" y="140" font-size="32">虚构统计图 · 42 项</text></svg>'
(root / 'chart.svg').write_text(svg)
def run(source):
    (root / 'source.svg').write_text(source)
    return subprocess.run(['bp-render-svg', '/workspace/source.svg', '/workspace/output.png', '--width', '1200'], capture_output=True, text=True, timeout=15)
result = run(svg)
assert result.returncode == 0, result.stdout + result.stderr
metadata = json.loads(result.stdout)
assert metadata['width'] == 1200 and metadata['height'] == 480
with Image.open(root / 'output.png') as image:
    image.load()
    assert image.mode == 'RGBA' and image.getpixel((0, 0))[3] == 0
    assert image.getbbox() is not None
for invalid in [
    svg.replace('<rect', '<foreignObject'),
    svg.replace('<rect', '<script'),
    svg.replace('fill="#e3f5ef"', 'fill="url(http://example.test/a)"'),
    svg.replace('<rect', '<image href="/workspace/secret.png"'),
    svg.replace('font-size="32"', 'style="font-size:32px"'),
    '<!DOCTYPE svg [<!ENTITY a "text">]>' + svg,
    svg.replace('width="600" height="240"', 'width="1" height="100000"'),
]:
    result = run(invalid)
    assert result.returncode != 0, invalid
    assert json.loads(result.stdout)['status'] == 'failed'
(root / 'linked.svg').symlink_to('/workspace/chart.svg')
result = subprocess.run(['bp-render-svg', '/workspace/linked.svg', '/workspace/out.png'], capture_output=True)
assert result.returncode != 0
print('SVG drawing: Chinese PNG, transparency, size and unsupported-resource checks passed')

# Path errors are explicit, correctable failures and never relax filesystem bounds.
help_result = subprocess.run(['bp-render-svg', '--help'], capture_output=True, text=True)
assert 'absolute' in help_result.stdout and '/workspace/chart.svg' in help_result.stdout
for source in ['chart.svg', '/workspace/../chart.svg', 'C:/workspace/chart.svg']:
    result = subprocess.run(['bp-render-svg', source, '/workspace/corrected.png'], capture_output=True, text=True)
    assert result.returncode == 1
    error = json.loads(result.stdout)
    assert error['code'] == 'svg_path_denied' and 'absolute Linux paths' in error['guidance']
subprocess.run(['bp-render-svg', '/workspace/chart.svg', '/workspace/corrected.png'], check=True, capture_output=True)
assert Path('/workspace/corrected.png').is_file()
print('SVG rejected path -> correction -> PNG passed')

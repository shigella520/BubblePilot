"""Offline fictional workloads; run inside the runtime container, never on NAS data."""
import importlib
import io
import json
import os
from pathlib import Path
import resource
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

manifest = json.loads(Path('/opt/bubblepilot/capabilities.json').read_text())
assert manifest['schemaVersion'] == 1
for command in manifest['commands']:
    assert shutil.which(command), command
# Prevent removed vulnerable tools and their avoidable dependencies returning transitively.
for command in ['gawk', 'curl', 'wget', 'dig', 'git']:
    assert shutil.which(command) is None, command
packages = subprocess.check_output(['dpkg-query', '-W', '-f=${binary:Package}\n'], text=True)
installed = {line.split(':')[0] for line in packages.splitlines()}
assert not installed.intersection({'gawk', 'curl', 'wget', 'dnsutils', 'bind9-dnsutils', 'git',
    'libcurl3t64-gnutls', 'libcurl4t64', 'libxml2', 'liblmdb0', 'perl', 'libperl5.40', 'perl-modules-5.40'})
for module in manifest['pythonModules']:
    importlib.import_module(module)
subprocess.run(['pip', 'check'], check=True)
assert os.environ['OPENBLAS_NUM_THREADS'] == '1'
from bs4 import BeautifulSoup
import httpx
import numpy as np
import pandas as pd
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
import yaml

with tempfile.TemporaryDirectory(dir='/workspace') as folder:
    root = Path(folder)
    # 10k fictional rows, well below large-data use cases.
    frame = pd.DataFrame({'group': ['cat', 'dog'] * 5000, 'value': np.arange(10000)})
    frame.to_csv(root / 'input.csv', index=False)
    assert int(pd.read_csv(root / 'input.csv')['value'].sum()) == 49995000
    frame.head(100).to_excel(root / 'input.xlsx', index=False)
    assert len(pd.read_excel(root / 'input.xlsx')) == 100
    Image.new('RGB', (32, 24), 'white').save(root / 'image.png')
    assert Image.open(root / 'image.png').size == (32, 24)
    assert yaml.safe_load('fictional: 42')['fictional'] == 42
    assert BeautifulSoup('<p>fictional cat</p>', 'html.parser').get_text() == 'fictional cat'
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 10 100 Td (Fictional menu 42) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    writer.write(root / 'text.pdf')
    assert 'Fictional menu 42' in PdfReader(root / 'text.pdf').pages[0].extract_text()
    with sqlite3.connect(root / 'sample.db') as db:
        assert db.execute('select 6 * 7').fetchone()[0] == 42
    with zipfile.ZipFile(root / 'sample.zip', 'w') as archive:
        archive.writestr('fictional.txt', '虚构数据 42')
    subprocess.run(['unzip', '-q', str(root / 'sample.zip'), '-d', str(root / 'unzipped')], check=True)
    assert (root / 'unzipped/fictional.txt').read_text() == '虚构数据 42'
    assert subprocess.check_output(['jq', '-r', '.answer'], input=b'{"answer":42}').strip() == b'42'

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404 if self.path == '/missing' else 200)
        self.end_headers()
        self.wfile.write(b'fictional response')
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    url = f'http://127.0.0.1:{server.server_port}'
    with httpx.Client(trust_env=False) as client:
        assert client.get(url).text == 'fictional response'
        assert client.get(url + '/missing').status_code == 404
    with tempfile.TemporaryDirectory(dir='/workspace') as folder:
        target = Path(folder) / 'download.txt'
        with httpx.stream('GET', url, trust_env=False) as response:
            response.raise_for_status()
            with target.open('wb') as output:
                for chunk in response.iter_bytes():
                    output.write(chunk)
        assert target.read_bytes() == b'fictional response'
    assert socket.getaddrinfo('localhost', server.server_port)
finally:
    server.shutdown()
    server.server_close()
print(json.dumps({'status': 'passed', 'runtime': manifest['id'], 'peakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}))

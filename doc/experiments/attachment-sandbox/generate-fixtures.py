"""Run inside the project Python sandbox image; creates only fictional files."""
from pathlib import Path
import sys
import zipfile
from openpyxl import Workbook
from PIL import Image

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
book = Workbook()
book.active.append(["region", "amount"])
book.active.append(["east", 10])
book.active.append(["west", 20])
book.save(root / "sample.xlsx")
(root / "sample.html").write_text("<h1>Fictional</h1>", encoding="utf8")
(root / "sample.yaml").write_text("amount: 30\n", encoding="utf8")
Image.new("RGB", (7, 11), "white").save(root / "sample.png")
with zipfile.ZipFile(root / "sample.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("example/data.txt", "fictional-archive")
# Minimal deterministic text-layer PDF; no extra PDF-generation dependency.
stream = b"BT /F1 12 Tf 20 80 Td (Fictional PDF amount 30) Tj ET"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(root / "sample.pdf").write_bytes(pdf)

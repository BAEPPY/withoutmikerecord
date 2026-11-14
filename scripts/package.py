"""Package only installable extension files, with manifest.json at the ZIP root."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'extension' / 'manifest.json').read_text())['version']
target = root / 'dist' / f'withoutmikerecord-{version}.zip'
target.parent.mkdir(exist_ok=True)
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for source in sorted((root / 'extension').rglob('*')):
        if source.is_file():
            archive.write(source, source.relative_to(root / 'extension'))
print(target)

#!/usr/bin/env python3
"""Seed a tiny, offline source package for container boot/render checks."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('nsw_contours', ROOT / 'scripts/nsw-contours.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', type=Path, required=True)
parser.add_argument('--catalog', type=Path, required=True)
args = parser.parse_args()
stem = 'Fixture-CONT-AHD_56_2m'
if args.catalog.is_file():
    existing = json.loads(args.catalog.read_text())
    if existing.get('sourceUrl') == 'Offline container test fixture' and len(existing.get('sheets', [])) == 1:
        retained = args.data_dir / 'archives' / module.archive_filename(existing['sheets'][0])
        if retained.is_file():
            print('Reusing the retained offline fixture package.')
            sys.exit(0)
with tempfile.TemporaryDirectory() as temporary:
    stage = Path(temporary)
    source = stage / 'input.geojson'
    source.write_text(json.dumps({'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {'Elevation': elevation}, 'geometry': {'type': 'LineString',
         'coordinates': [[150.313, -33.677 + i * .0003], [150.315, -33.677 + i * .0003]]}}
        for i, elevation in enumerate((100, 110, 112))]}))
    subprocess.run(['ogr2ogr', '-f', 'ESRI Shapefile', '-t_srs', 'EPSG:28356', str(stage / (stem + '.shp')), str(source)], check=True)
    archive = stage / 'fixture.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for member in stage.glob(stem + '.*'):
            zipped.write(member, member.name)
    content = archive.read_bytes()
    sheet = {'id': stem, 'name': 'OFFLINE TEST FIXTURE', 'zone': '56',
             'url': f'http://127.0.0.1:9/{stem}.zip', 'bytes': len(content),
             'etag': '"' + hashlib.sha256(content).hexdigest() + '"', 'bounds': [150.312, -33.678, 150.316, -33.675]}
    retained = args.data_dir / 'archives'
    retained.mkdir(parents=True, exist_ok=True)
    (retained / module.archive_filename(sheet)).write_bytes(content)
    args.catalog.parent.mkdir(parents=True, exist_ok=True)
    args.catalog.write_text(json.dumps({'format': 1, 'sourceUrl': 'Offline container test fixture', 'sheets': [sheet]}))
print('Seeded one offline sheet; boot must prepare it without contacting an elevation service.')

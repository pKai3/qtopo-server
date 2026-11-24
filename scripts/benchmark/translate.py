#!/usr/bin/env python3
"""Shift a saved trace by whole tiles at its lowest zoom, preserving nesting."""
import argparse
import copy
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--dx', required=True, type=int)
parser.add_argument('--dy', type=int, default=0)
args = parser.parse_args()
trace = copy.deepcopy(json.loads(args.source.read_text()))
base_zoom = min(r['z'] for r in trace['requests'])
relative = trace.get('coordinates') == 'relative'
if relative:
    trace['anchor']['x'] += args.dx
    trace['anchor']['y'] += args.dy
for record in trace['requests']:
    scale = 2 ** (record['z'] - base_zoom)
    if not relative:
        record['x'] += args.dx * scale
        record['y'] += args.dy * scale
    x = record['x'] + (trace['anchor']['x'] * scale if relative else 0)
    y = record['y'] + (trace['anchor']['y'] * scale if relative else 0)
    if not (0 <= x < 2**record['z'] and 0 <= y < 2**record['z']):
        raise ValueError('Translation crosses a tile-world edge')
    if not relative:
        record['path'] = '/{profile}/{z}/{x}/{y}.png'.format(**record)
trace['translation'] = dict(baseZoom=base_zoom, dx=args.dx, dy=args.dy,
                            note='Integer translation preserves tile relationships across zoom levels. Original response timings describe the source recording, not this new location.')
args.output.write_text(json.dumps(trace, indent=2)+'\n')
print(f'Translated {len(trace["requests"])} requests at reference zoom {base_zoom}')

#!/usr/bin/env python3
"""Save a portable pan pattern with relative coordinates and no capture timestamps."""
import argparse
import json
import math
from pathlib import Path


def normalize(trace, anchor=None):
    records = trace['requests']
    base_zoom = min(t['z'] for t in records)
    first = records[0]
    origin_x = first['x'] // 2**(first['z']-base_zoom)
    origin_y = first['y'] // 2**(first['z']-base_zoom)
    # Fixed inland Queensland reference, independent of the captured location.
    anchor = anchor or [math.floor(116 * 2**(base_zoom-7)), math.floor(72 * 2**(base_zoom-7))]
    if not all(0 <= value < 2**base_zoom for value in anchor):
        raise ValueError('Anchor outside tile world')
    output = dict(kind=trace['kind'], coordinates='relative', baseZoom=base_zoom,
                  anchor=dict(x=anchor[0], y=anchor[1]), durationMs=trace['durationMs'],
                  groupGapMs=trace.get('groupGapMs', 350), groups=trace['groups'],
                  description='Recorded request timing and relative pan pattern, relocated to a fixed Queensland reference. Not a recording of camera gestures.', requests=[])
    for tile in records:
        result = {k:tile[k] for k in ('profile','z','t','group','durationMs','outcome') if k in tile}
        scale = 2**(tile['z']-base_zoom)
        result.update(x=tile['x']-origin_x*scale, y=tile['y']-origin_y*scale)
        output['requests'].append(result)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--anchor', nargs=2, type=int, metavar=('X','Y'))
    args = parser.parse_args()
    trace = normalize(json.loads(args.source.read_text()), args.anchor)
    requests = trace.pop('requests')
    header = json.dumps(trace, indent=2).rstrip()[:-1].rstrip()
    args.output.write_text(header + ',\n  "requests": [\n    ' + ',\n    '.join(json.dumps(t,separators=(',', ':')) for t in requests) + '\n  ]\n}\n')
    print(f'Saved {len(requests)} requests; original location and capture date omitted')

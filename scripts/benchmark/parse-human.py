#!/usr/bin/env python3
"""Extract an explicitly selected interval from QTopo's request log."""
import argparse
import datetime as dt
import json
import re

STAMP = re.compile(r"\[([^\]]+Z)\] \[(REQ|RES)\]:\s+(.*)")
PATH = r"/((?:readable|mobile|mobile-3x|light|hiking-light)/)?(\d+)/(\d+)/(\d+)\.png"


def milliseconds(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def parse(lines, start, end):
    requests, unmatched = [], []
    for line in lines:
        match = STAMP.search(re.sub(r'\x1b\[[0-9;]*m', '', line))
        if not match:
            continue
        timestamp, kind, body = match.groups()
        route = re.search(PATH, body)
        if not route:
            continue
        at = milliseconds(timestamp)
        path = route.group(0)
        if kind == 'REQ' and start <= at <= end:
            profile, z, x, y = route.groups()
            record = dict(id=len(requests), at=at, path=path,
                          profile=(profile or 'readable/').rstrip('/'),
                          z=int(z), x=int(x), y=int(y))
            requests.append(record)
            unmatched.append(record)
        elif kind == 'RES':
            duration = re.search(r'\((\d+) ms\)', body)
            if not duration:
                continue
            elapsed = int(duration[1])
            candidates = [r for r in unmatched if r['path'] == path and r['at'] <= at]
            if candidates:
                # Retries may finish out of order. Duration identifies their arrival.
                record = min(candidates, key=lambda r: abs(r['at'] - (at - elapsed)))
                record.update(durationMs=elapsed, endedAt=at,
                              outcome='abandoned' if 'Disconnected:' in body else body.split()[0])
                unmatched.remove(record)
    if not requests:
        raise ValueError('No tile requests in selected interval')
    origin = requests[0]['at']
    group = -1
    previous = None
    for r in requests:
        # These are observed request bursts, not reconstructed viewports.
        if previous is None or r['at'] - previous['at'] > 350 or (r['z'], r['profile']) != (previous['z'], previous['profile']):
            group += 1
        r['group'] = group
        r['t'] = round(r['at'] - origin)
        if 'endedAt' in r:
            r['endMs'] = round(r.pop('endedAt') - origin)
        r.pop('at')
        previous = dict(r, at=origin + r['t'])
    return dict(kind='human-computer', recordedAt=dt.datetime.fromtimestamp(origin / 1000, dt.timezone.utc).isoformat(),
                durationMs=requests[-1]['t'], groupGapMs=350, groups=group + 1,
                description='Computer raster tile request arrivals; idle lead-in and late stray requests excluded. Browser cache and camera gestures are not recorded.',
                requests=requests)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log')
    parser.add_argument('output')
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--kind', choices=['human-phone','human-computer'], default='human-computer')
    args = parser.parse_args()
    with open(args.log) as source:
        trace = parse(source, milliseconds(args.start), milliseconds(args.end))
    trace['kind'] = args.kind
    trace['description'] = 'Recorded raster requests in the selected active interval. Browser cache and camera gestures are not recorded.'
    with open(args.output, 'w') as target:
        json.dump(trace, target, indent=2)
        target.write('\n')
    print(json.dumps({k: v for k, v in trace.items() if k != 'requests'}))

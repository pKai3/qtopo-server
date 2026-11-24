#!/usr/bin/env python3
"""Validate saved benchmark traffic and summarize comparable phases."""
import argparse
import collections
import csv
import json
import math
import re
from pathlib import Path


def summarize(directory):
    rows, checks = [], []
    for path in sorted(directory.glob('*.json')):
        report = json.loads(path.read_text())
        if not isinstance(report, dict) or 'requests' not in report or 'phases' not in report:
            continue
        run = report['run']
        expected = collections.Counter('/{profile}/{z}/{x}/{y}.png'.format(**r) for r in report['requests'])
        actual = collections.Counter()
        log = directory / (run + '-server.log')
        if log.exists():
            for line in log.read_text().splitlines():
                match = re.search(r'\[REQ\]:\s+GET (/[^/]+/\d+/\d+/\d+\.png)', line)
                if match:
                    actual[match[1]] += 1
        extra = sum((actual - expected).values()) if log.exists() else None
        missing = sum((expected - actual).values()) if log.exists() else None
        settings = report['before']['settings']
        check = dict(run=run, revision=report['before']['revision'],
                     radius=settings['prefetchRadius'], zoom=settings['prefetchZoom'], preempt=settings['prefetchPreempt'],
                     extraRequests=extra, requestsNotSeen=missing,
                     error=report.get('error'), safetyStop=report.get('safetyStop'),
                     initialMemoryEvents=report.get('initialMemoryEvents'), finalMemoryEvents=report.get('finalMemoryEvents'),
                     summary=report.get('summary'), styles=report.get('styles'))
        checks.append(check)
        for phase in report['phases']:
            groups = collections.defaultdict(list)
            for request in report['requests']:
                if request['phase'] == phase['name']:
                    groups[request['group']].append(request)
            burst_stats = {}
            for fraction in (50, 75, 100):
                values = []
                for group in groups.values():
                    began = min(t['startedMs'] for t in group)
                    ends = sorted(t['startedMs'] + t['ms'] for t in group if t.get('ok'))
                    needed = math.ceil(len(group) * fraction / 100)
                    if len(ends) >= needed:
                        values.append((ends[needed - 1] - began) / 1000)
                values.sort()
                burst_stats.update({
                    f'burst_{fraction}_median_s': values[math.ceil(len(values)*.5)-1] if values else None,
                    f'burst_{fraction}_p95_s': values[math.ceil(len(values)*.95)-1] if values else None,
                    f'burst_{fraction}_unreached': len(groups)-len(values),
                })
            rows.append(dict(run=run, phase=phase['name'], radius=settings['prefetchRadius'],
                             zoom=settings['prefetchZoom'], interrupt=settings['prefetchPreempt'],
                             requests=phase['requests'], median_s=phase['medianMs']/1000 if phase['medianMs'] is not None else None,
                             p95_s=phase['p95Ms']/1000 if phase['p95Ms'] is not None else None,
                             foreground_s=phase['foregroundMs']/1000, drain_s=phase.get('drainMs', 0)/1000,
                             final_view_s=phase.get('finalViewMs', 0)/1000,
                             cache_hits=phase['delta']['hits'], prefetch_reuse=phase['delta']['prefetchUsed'],
                             renders=phase['delta']['render_completed'], abandoned=phase['abandoned'], errors=phase['errors'],
                             extra_requests=extra, peak_working_gib=report.get('summary', {}).get('peakWorking', 0)/1024**3,
                             movement_s=phase.get('movementMs', phase['foregroundMs'])/1000,
                             outstanding_tail_s=phase.get('outstandingTailMs', 0)/1000, **burst_stats))
    return rows, checks


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    rows, checks = summarize(args.directory)
    if rows:
        with (args.directory/'comparison.csv').open('w') as target:
            writer = csv.DictWriter(target, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    (args.directory/'comparison.json').write_text(json.dumps(dict(rows=rows, checks=checks), indent=2)+'\n')
    print(f'{len(checks)} runs, {len(rows)} phases. Unrelated request counts:', {c['run']: c['extraRequests'] for c in checks})

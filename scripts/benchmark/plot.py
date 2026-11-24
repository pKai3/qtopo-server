#!/usr/bin/env python3
"""Export response-time box plots from completed reports (requires matplotlib)."""
import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
parser.add_argument('--phone', action='store_true', help='Focus on delivery-sensitive phone replays and burst readiness')
args = parser.parse_args()
reports = []
for path in sorted(args.directory.glob('*.json')):
    r = json.loads(path.read_text())
    if isinstance(r, dict) and 'run' in r and 'phases' in r and not r.get('error'):
        reports.append(r)
phases = [('fresh-batches', 'Fresh batches', None), ('steady-pan', 'Steady pan', None),
          ('human-phone-full-clock', 'Phone · full route with pauses', None), ('human-phone-paced', 'Phone · wait for all tiles', None)]
if args.phone:
    phases = [(phase, label + ' · ' + metric_label, metric)
              for phase, label in [('human-phone-paced', 'Wait for all'), ('human-phone-partial', 'Partial delivery')]
              for metric, metric_label in [(None, 'each tile'), (50, '50% of burst'), (75, '75% of burst')]]
fig, axes = plt.subplots(2, 3 if args.phone else 2, figsize=(16, 9) if args.phone else (13, 9), facecolor='#f2f5ef')
palette = ['#5d8eaa', '#5d9174', '#b29a65', '#827fa9', '#629c9a', '#b78177', '#929c5e']
for ax, (phase, title, metric) in zip(axes.flat, phases):
    series, labels, counts = [], [], []
    for report in reports:
        records = [r for r in report['requests'] if r['phase'] == phase]
        if metric is None:
            values = [r['ms']/1000 for r in records if r.get('ok')]
            excluded = sum(bool(r.get('abandoned') or r.get('error')) for r in records)
        else:
            groups = defaultdict(list)
            for record in records:
                groups[record['group']].append(record)
            values, excluded = [], 0
            for group in groups.values():
                start = min(t['startedMs'] for t in group)
                ends = sorted(t['startedMs']+t['ms'] for t in group if t.get('ok'))
                needed = math.ceil(len(group)*metric/100)
                if len(ends) >= needed:
                    values.append((ends[needed-1]-start)/1000)
                else:
                    excluded += 1
        if values:
            series.append(values)
            label = report['run'].replace('-synthetic', '').replace('-phone', '')
            if args.phone:
                radius = report['before']['settings']['prefetchRadius']
                label = ('Off' if radius == 0 else f'Radius {radius}') + f'\nn={len(values)}'
                if excluded:
                    label += f' ({excluded} excluded)'
            labels.append(label)
            counts.append(sum(bool(r.get('abandoned')) for r in records))
    ax.set_facecolor('#ffffff')
    ax.set_title(title, loc='left', fontsize=13, fontweight='bold', color='#213b30', pad=14)
    ax.spines[['top', 'right', 'left']].set_visible(False)
    ax.spines['bottom'].set_color('#c6d0c5')
    ax.grid(axis='x', color='#e3e9e1', linewidth=.7)
    ax.set_axisbelow(True)
    ax.tick_params(axis='both', labelsize=9, color='#c6d0c5')
    ax.xaxis.set_major_locator(MaxNLocator(5))
    ax.set_xlabel('Time since burst started (seconds)' if metric else 'Response time (seconds)', fontsize=10, color='#4e6758')
    if not series:
        ax.text(.5, .5, 'Not run yet', ha='center', va='center', transform=ax.transAxes, color='#61776a')
        ax.set_yticks([])
        continue
    plot = ax.boxplot(series, orientation='horizontal', patch_artist=True, tick_labels=labels,
                      medianprops=dict(color='#253c30', linewidth=1.7),
                      flierprops=dict(marker='.', markersize=2.5, alpha=.35), widths=.6)
    for index, patch in enumerate(plot['boxes']):
        color = palette[index % len(palette)]
        patch.set_facecolor(color+'55')
        patch.set_edgecolor(color)
        jitter = [index + 1 + (((j * 37) % 101) / 100 - .5) * .35 for j in range(len(series[index]))]
        ax.scatter(series[index], jitter, s=4, alpha=.18, color=color, edgecolors='none', zorder=1)
    ax.invert_yaxis()
    ax.set_xlim(left=0)
fig.suptitle('QTopo · delivery-sensitive phone comparisons' if args.phone else 'QTopo · prefetch settings on Stable', x=.055, y=.985, ha='left', fontsize=20, fontweight='bold', color='#203b30')
fig.text(.055, .944, 'Same resources · empty raster and vector caches per workload · one run at a time', fontsize=11, color='#536e5d')
fig.text(.055, .025, 'Boxes: middle 50% · line: median · whiskers: 1.5× IQR · faint dots: individual measurements · darker dots: outliers\n' +
         ('Bursts are request groups, not known viewports. Excluded: cancelled/failed tiles or bursts that never reach the stated fraction. These are replay models.' if args.phone else
          'Successful full-PNG responses only. Intentional cancellations are counted separately in the comparison table.'), fontsize=9, color='#536e5d')
fig.tight_layout(rect=[.035, .065, .995, .925], h_pad=2.5, w_pad=2)
name = 'phone-delivery-boxplots' if args.phone else 'prefetch-boxplots'
fig.savefig(args.directory/(name+'.png'), dpi=160, facecolor=fig.get_facecolor())
fig.savefig(args.directory/(name+'.svg'), facecolor=fig.get_facecolor())

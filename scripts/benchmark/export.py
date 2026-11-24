#!/usr/bin/env python3
"""Create a self-contained HTML replay; no server is required to open it."""
import argparse
import base64
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('events', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
events = []
for line in args.events.read_text().splitlines():
    try:
        events.append(json.loads(line))
    except ValueError:
        pass
html = Path(__file__).with_name('viewer.html').read_text()
start = html.index('async function poll()')
end = html.index("$('run').onchange", start)
payload = json.dumps(events, separators=(',', ':')).replace('<', '\\u003c')
loader = '''async function poll(){
  const saved=PAYLOAD;
  for(const event of saved)addEvent(event);
  $('connection').textContent='Saved comparison · ready to replay';
  boxplots();draw();
}
'''.replace('PAYLOAD', payload)
html = html[:start] + loader + html[end:]
reference = args.events.with_name('stable-latest-boxplot.png')
if reference.exists():
    html = html.replace('/stable-latest-boxplot.png', 'data:image/png;base64,' + base64.b64encode(reference.read_bytes()).decode())
else:
    html = re.sub(r'<details class="panel" id="referencePanel">.*?</details>', '', html, flags=re.S)
args.output.write_text(html)
print(f'Saved {len(events)} events to {args.output}')

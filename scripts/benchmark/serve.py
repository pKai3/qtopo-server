#!/usr/bin/env python3
"""Local, read-only benchmark viewer. Never requests map tiles."""
import argparse
import http.server
import json
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--events', required=True, type=Path)
parser.add_argument('--port', type=int, default=8766)
args = parser.parse_args()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/events':
            try:
                offset = max(0, int(parse_qs(url.query).get('after', ['0'])[0]))
            except ValueError:
                self.send_error(400)
                return
            events = []
            if args.events.exists():
                with args.events.open('rb') as source:
                    source.seek(offset)
                    for _ in range(2000):
                        line = source.readline()
                        if not line or not line.endswith(b'\n'):
                            break
                        offset = source.tell()
                        try:
                            events.append(json.loads(line))
                        except (ValueError, UnicodeError):
                            pass
            body = json.dumps(dict(next=offset, events=events)).encode()
            content_type = 'application/json'
        elif url.path in ('/', '/viewer.html'):
            html = Path(__file__).with_name('viewer.html').read_text()
            if not args.events.with_name('stable-latest-boxplot.png').exists():
                html = re.sub(r'<details class="panel" id="referencePanel">.*?</details>', '', html, flags=re.S)
            body = html.encode()
            content_type = 'text/html; charset=utf-8'
        elif url.path == '/stable-latest-boxplot.png' and args.events.with_name('stable-latest-boxplot.png').exists():
            body = args.events.with_name('stable-latest-boxplot.png').read_bytes()
            content_type = 'image/png'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


print(f'Benchmark viewer: http://127.0.0.1:{args.port}', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()

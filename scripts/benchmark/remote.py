#!/usr/bin/env python3
"""Stage a self-contained benchmark on a Docker host and collect its results."""
import argparse
import datetime as dt
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import uuid


def quote_command(parts):
    return ' '.join(shlex.quote(str(p)) for p in parts)


def unpack(payload, destination):
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe result archive entry: ' + member.name)
        archive.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='SSH destination, e.g. root@tower.local')
    parser.add_argument('--container', default='qtopo-server-stable')
    parser.add_argument('--preset', choices=['partial','sweep','confirm','synthetic'], default='partial')
    parser.add_argument('--work-root', default='/mnt/user/appdata/qtopo-benchmarks', help='Persistent directory on the Docker host')
    parser.add_argument('--output', type=Path, help='New local results directory')
    parser.add_argument('--ssh-option', action='append', default=[], help='An OpenSSH option such as HostKeyAlias=tower.local')
    parser.add_argument('--check', action='store_true', help='Stage tools and check prerequisites without running tests or changing the container')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', args.container):
        parser.error('Invalid container name')
    if args.host.startswith('-') or not args.work_root.startswith('/'):
        parser.error('Use a normal SSH host and an absolute remote work root')
    session_id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    source = Path(__file__).resolve().parent
    output = (args.output or source.parent.parent/'benchmark-results'/session_id).resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    remote = args.work_root.rstrip('/') + '/' + session_id
    ssh = ['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes']
    for option in args.ssh_option:
        ssh.extend(['-o', option])
    ssh.append(args.host)
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w:gz') as archive:
        for path in sorted(source.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and not path.name.endswith('.pyc'):
                archive.add(path, arcname='scripts/benchmark/'+str(path.relative_to(source)), recursive=False)
    staging = 'umask 077; mkdir -p ' + shlex.quote(remote) + ' && tar -xzf - -C ' + shlex.quote(remote)
    subprocess.run(ssh+[staging], input=payload.getvalue(), check=True)
    env = ['env', 'BENCHMARK_CONTAINER='+args.container, 'BENCHMARK_RESULTS_DIR='+remote+'/results']
    runner = remote+'/scripts/benchmark/tower-run.sh'
    if args.check:
        command = env+['bash', runner, '--check']
    elif args.preset == 'synthetic':
        command = env+['bash', runner, 'r2-synthetic', '2','1','1','synthetic','synthetic.json']
    else:
        command = env+['bash',remote+'/scripts/benchmark/tower-'+args.preset+'.sh']
    metadata = dict(host=args.host, container=args.container, remoteDirectory=remote, preset=args.preset, checkOnly=args.check)
    (output/'session.json').write_text(json.dumps(metadata,indent=2)+'\n')
    print('Remote session:',remote,flush=True)
    print('Local results:',output,flush=True)
    print('Viewer: python3 scripts/benchmark/serve.py --events '+shlex.quote(str(output/'events.jsonl')),flush=True)
    process = subprocess.Popen(ssh+['exec '+quote_command(command)], stdout=subprocess.PIPE, text=True)
    last_progress = -10000
    try:
        with (output/'events.jsonl').open('w') as events:
            for line in process.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    print(line.rstrip(),flush=True); continue
                if not isinstance(event, dict):
                    print(line.rstrip(),flush=True); continue
                events.write(json.dumps(event)+'\n'); events.flush()
                if event.get('message'):
                    print(event['message'],flush=True)
                elif event.get('event') in ('start','phase','complete','failed','safety-stop'):
                    print(event.get('run'),event.get('phase',''),event.get('event'),event.get('state',''),flush=True)
                    if event.get('event')=='start': last_progress=-10000
                elif event.get('event')=='sample' and event['t']-last_progress>=5000:
                    last_progress=event['t']
                    print(f"  {event['t']/1000:.0f}s · {event['active']} workers · {event['working']/1024**3:.2f} GiB",flush=True)
                elif args.check:
                    print(json.dumps(event,indent=2),flush=True)
        code = process.wait()
    except KeyboardInterrupt:
        process.terminate()
        process.wait()
        print('Connection interrupted. Inspect the remote session before running another test; recovery snapshots are retained at '+remote,flush=True)
        return 130
    if not args.check:
        collected = subprocess.run(ssh+['tar -czf - -C '+shlex.quote(remote+'/results')+' .'], stdout=subprocess.PIPE, check=True)
        unpack(collected.stdout,output)
        subprocess.run(['python3',str(source/'summarize.py'),str(output)],check=True)
        subprocess.run(['python3',str(source/'export.py'),str(output/'events.jsonl'),str(output/'replay.html')],check=True)
    print('Finished. Results:',output,flush=True)
    return code


if __name__=='__main__':
    raise SystemExit(main())

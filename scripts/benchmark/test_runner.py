#!/usr/bin/env python3
"""Exercise the host runner against a fake Docker daemon, never real containers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
FAKE = r'''#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
root=pathlib.Path(os.environ['FAKE_ROOT']); name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
state_path=root/'state.json'
def load():
 if not state_path.exists(): sys.exit(1)
 return json.loads(state_path.read_text())
def save(s):state_path.write_text(json.dumps(s))
def mark(msg):
 with (root/'mutations').open('a') as f:f.write(msg+'\n')
if name=='flock':sys.exit(0)
if name=='readlink':print(pathlib.Path(args[-1]).resolve());sys.exit(0)
if name=='timeout':os.execvp(args[1],args[1:])
if name=='docker':
 cmd=args[0]
 if cmd=='inspect':
  s=load()
  if args[-1]!=s['Name'].lstrip('/'):sys.exit(1)
  if '-f' not in args:print(json.dumps([s]))
  else:
   f=args[args.index('-f')+1];print(s['Id'] if '.Id' in f else str(s['State']['Running']).lower())
 elif cmd=='image':print('sha256:original')
 elif cmd=='stop':
  s=load();s['State']['Running']=False;save(s);mark('stop')
 elif cmd=='rm':state_path.unlink();mark('rm')
 elif cmd=='start':
  s=load();s['State']['Running']=True;save(s);mark('start')
 elif cmd=='cp':
  if args[1].startswith('qtopo-server-stable:'):
   shutil.copyfile(root/'report.json',args[2])
 elif cmd=='exec':
  if '--validate' in args or '-e' in args:sys.exit(0)
  report={'run':'trial','started':'2026-01-01T00:00:00Z','requests':[],'phases':[]}
  (root/'report.json').write_text(json.dumps(report));mark('workload')
  print(json.dumps({'event':'complete','run':'trial'}));sys.exit(int(os.environ.get('FAIL_WORKLOAD','0')))
 elif cmd=='logs':print('No real tiles were requested')
 else:raise RuntimeError(args)
elif name=='curl':
 if '--data-binary' in args:
  n=int((root/'creates').read_text())+1 if (root/'creates').exists() else 1
  (root/'creates').write_text(str(n))
  if n<=int(os.environ.get('FAIL_CREATES','0')):sys.exit(22)
  payload=json.loads(pathlib.Path(args[args.index('--data-binary')+1][1:]).read_text())
  orig=json.loads((root/'original.json').read_text())
  s=dict(orig);s['Config']={k:v for k,v in payload.items() if k not in ('HostConfig','NetworkingConfig')}
  s['HostConfig']=payload['HostConfig'];s['Id']='new-'+str(n);s['State']={'Running':False,'OOMKilled':False};save(s);mark('create')
  print(json.dumps({'Id':s['Id']}))
 else:
  s=load();env=dict(v.split('=',1) for v in s['Config']['Env']);settings={'tilePx':512,'renderConcurrency':7,'upstreamConcurrency':3,'prefetchRadius':int(env['PREFETCH_RADIUS']),'prefetchZoom':env['PREFETCH_ZOOM']=='1','prefetchPreempt':env['PREFETCH_PREEMPT']=='1'}
  print(json.dumps({'revision':'fixture','settings':settings,'renderer':{'active':0,'queued':0},'requests':{'active':0},'prefetch':{},'cache':{'downloads':{'active':0,'queued':0}}}))
'''


@unittest.skipUnless(shutil.which('jq') and shutil.which('bash'), 'bash and jq required')
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        bin_dir=self.root/'bin';bin_dir.mkdir()
        for tool in ('docker','curl','flock','timeout','readlink'):
            path=bin_dir/tool;path.write_text(FAKE);path.chmod(0o755)
        self.data=self.root/'data';self.data.mkdir()
        for kind in ('raster','vector','styles'):
            folder=self.data/kind/('v2' if kind!='styles' else 'live');folder.mkdir(parents=True)
            (folder/'keep').write_text('data')
        self.original={'Id':'original-id','Name':'/qtopo-server-stable','Image':'sha256:original',
          'Config':{'Image':'fixture:tag','Env':['PREFETCH_RADIUS=2','PREFETCH_ZOOM=1','PREFETCH_PREEMPT=1','SECRET=keep'],'Labels':{'keep':'yes'}},
          'HostConfig':{'Memory':2147483648,'NanoCpus':4000000000,'CpusetCpus':'2-5','PortBindings':{'8080/tcp':[{'HostIp':'','HostPort':'9878'}]},'RestartPolicy':{'Name':'unless-stopped'}},
          'Mounts':[{'Source':str(self.data),'Destination':'/data','Type':'bind','RW':True}],
          'NetworkSettings':{'Networks':{'custom':{'Aliases':['qtopo-server-stable'],'IPAMConfig':None,'Links':None,'DriverOpts':None}}},
          'State':{'Running':True,'OOMKilled':False}}
        for name in ('state.json','original.json'):(self.root/name).write_text(json.dumps(self.original))
        self.env=dict(os.environ,PATH=str(bin_dir)+os.pathsep+os.environ['PATH'],FAKE_ROOT=str(self.root),BENCHMARK_RESULTS_DIR=str(self.root/'results'))
    def tearDown(self):self.temp.cleanup()
    def invoke(self,*args,**extra):
        return subprocess.run(['bash',str(ROOT/'tower-run.sh'),*args],env=dict(self.env,**extra),text=True,capture_output=True)
    def run_trial(self,**env):return self.invoke('trial','1','0','1','synthetic','synthetic.json',**env)
    def assert_restored(self):
        after=json.loads((self.root/'state.json').read_text())
        for field in ('Config','HostConfig','Image'):self.assertEqual(after[field],self.original[field])
        self.assertTrue(after['State']['Running'])
        self.assertFalse((self.root/'results/trial/restore-needed').exists())
    def test_check_is_read_only(self):
        result=self.invoke('--check');self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((self.root/'mutations').exists());self.assertFalse((self.root/'results').exists())
    def test_fresh_run_preserves_nonstandard_resources_and_styles(self):
        result=self.run_trial();self.assertEqual(result.returncode,0,result.stderr);self.assert_restored()
        self.assertFalse((self.data/'raster/v2').exists());self.assertFalse((self.data/'vector/v2').exists())
        self.assertTrue((self.data/'styles/live/keep').exists())
        expected=json.loads((self.root/'results/trial/expected.json').read_text())
        self.assertEqual(expected['memoryBytes'],2147483648);self.assertEqual(expected['settings']['renderConcurrency'],7)
    def test_failed_workload_restores(self):
        result=self.run_trial(FAIL_WORKLOAD='7');self.assertEqual(result.returncode,7,result.stderr);self.assert_restored()
    def test_failed_create_restores(self):
        result=self.run_trial(FAIL_CREATES='1');self.assertNotEqual(result.returncode,0);self.assert_restored()
    def test_failed_restore_retains_manual_recovery(self):
        result=self.run_trial(FAIL_CREATES='2');self.assertNotEqual(result.returncode,0)
        folder=self.root/'results/trial';self.assertTrue((folder/'restore-needed').exists())
        result=self.invoke('--restore',str(folder));self.assertEqual(result.returncode,0,result.stderr);self.assert_restored()
    def test_symlink_cache_is_refused(self):
        shutil.rmtree(self.data/'raster/v2');(self.data/'raster/v2').symlink_to(self.data/'styles',target_is_directory=True)
        result=self.run_trial();self.assertNotEqual(result.returncode,0);self.assertFalse((self.root/'mutations').exists())
        self.assertTrue((self.data/'styles/live/keep').exists())
    def test_existing_run_is_not_overwritten(self):
        folder=self.root/'results/trial';folder.mkdir(parents=True);(folder/'marker').write_text('keep')
        result=self.run_trial();self.assertNotEqual(result.returncode,0);self.assertFalse((self.root/'mutations').exists())
        self.assertEqual((folder/'marker').read_text(),'keep')


if __name__=='__main__':unittest.main()

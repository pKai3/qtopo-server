"""Offline checks for retained downloads and atomic contour publication."""
import contextlib
import gzip
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

SPEC = importlib.util.spec_from_file_location('nsw_contours', Path(__file__).resolve().parents[1] / 'scripts/nsw-contours.py')
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
STEM = 'Fixture-CONT-AHD_56_2m'


class ArchiveServer:
    def __init__(self, payload, mode='valid'):
        self.payload, self.mode, self.ranges = payload, mode, []
        fixture = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_HEAD(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(fixture.payload)))
                self.send_header('ETag', '"fixture"')
                self.end_headers()
            def do_GET(self):
                match = re.fullmatch(r'bytes=(\d+)-(\d+)', self.headers.get('Range', ''))
                if not match:
                    self.send_error(400)
                    return
                start, end = map(int, match.groups())
                fixture.ranges.append((start, end, self.headers.get('If-Match')))
                content = fixture.payload[start:end + 1]
                self.send_response(200 if fixture.mode == 'ignored' else 206)
                self.send_header('Content-Length', str(len(content)))
                self.send_header('Content-Range', f'bytes {start + (fixture.mode == "bad-range")}-{end}/{len(fixture.payload)}')
                self.send_header('ETag', '"changed"' if fixture.mode == 'changed' else '"fixture"')
                self.end_headers()
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    self.wfile.write(content[:17] if fixture.mode == 'truncated' else content)
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.url = f'http://127.0.0.1:{self.server.server_port}/{STEM}.zip'
    def __enter__(self):
        self.thread.start()
        return self
    def __exit__(self, *_args):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def sheet(self, identifier='fixture'):
        return {'id': identifier, 'zone': '56', 'name': 'Fixture', 'url': self.url, 'bytes': len(self.payload),
                'etag': '"fixture"', 'bounds': [150.30, -33.69, 150.33, -33.66]}


def fixture_zip(extra=None, compression=zipfile.ZIP_STORED, *, stem=STEM, prefix='', directories=()):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=compression) as archive:
        for directory in directories: archive.writestr(directory, b'')
        for suffix in ('.shp', '.shx', '.dbf', '.prj'):
            archive.writestr(prefix + stem + suffix, b'fixture contents ' + suffix.encode())
        if extra: archive.writestr(*extra)
    return stream.getvalue()


class ValidationTests(unittest.TestCase):
    def test_catalog_rejects_paths_duplicate_ids_unpinned_or_foreign_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'catalog.json'
            sheet = {'id': 'fixture', 'zone': '56', 'name': 'Fixture', 'bytes': 123, 'etag': '"etag"',
                     'url': f'https://portal.spatial.nsw.gov.au/download/contours/56/{STEM}.zip', 'bounds': [150, -34, 151, -33]}
            for changes in ({'id': '../escape'}, {'id': 'a\nb'}, {'url': 'https://example.com/data.zip'},
                            {'etag': 'W/"weak"'}, {'etag': '"x"\r\nRange: bytes=0-'}, {'bounds': [150, -33, 151, -34]}, {'bytes': 0}):
                with self.subTest(changes=changes):
                    path.write_text(json.dumps({'format': 1, 'sheets': [{**sheet, **changes}]}))
                    with self.assertRaises(mod.ImportFailure): mod.load_catalog(path)
            path.write_text(json.dumps({'format': 1, 'sheets': [sheet, sheet]}))
            with self.assertRaisesRegex(mod.ImportFailure, 'Duplicate'): mod.load_catalog(path)

    def test_zoom_rules_require_numeric_even_heights(self):
        geometry = {'type': 'LineString', 'coordinates': [[150, -33], [150.1, -33.1]]}
        for height, zoom in ((0, 10), (100, 10), (110, 12), (112, 15), (-2, 15)):
            result = mod.contour_feature({'type': 'Feature', 'properties': {'Elevation': height, 'discard': 'unused'}, 'geometry': geometry})
            self.assertEqual(result['properties'], {'elevation': height})
            self.assertEqual(result['tippecanoe'], {'minzoom': zoom})
        for height in ('112', None, float('nan'), 111, True):
            with self.subTest(height=height), self.assertRaises(mod.ImportFailure):
                mod.contour_feature({'type': 'Feature', 'properties': {'Elevation': height}, 'geometry': geometry})
        with self.assertRaises(mod.ImportFailure):
            mod.contour_feature({'type': 'Feature', 'properties': {}, 'geometry': None})

    def test_duplicate_lock_space_threshold_and_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            first = mod.Importer(directory, 'unused', 1024)
            second = mod.Importer(directory, 'unused', 1024)
            with first.lock(), self.assertRaises(mod.AlreadyRunning), second.lock(): pass
            with mock.patch.object(mod.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(5000, 4500, 500)):
                with self.assertRaises(mod.WaitingSpace): first.guard(100)
            first.stop.set()
            with self.assertRaises(mod.Interrupted): first.guard()

    def test_stop_terminates_running_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            importer = mod.Importer(directory, 'unused', 0)
            watcher = threading.Thread(target=importer.monitor)
            watcher.start()
            try:
                with importer.process([sys.executable, '-c', 'import time; time.sleep(30)'], stdout=subprocess.DEVNULL) as child:
                    importer.stop.set()
                    child.wait(timeout=5)
                    self.assertIsNotNone(child.returncode)
                    self.assertIsInstance(importer.failure, mod.Interrupted)
            finally:
                importer.monitor_done.set()
                watcher.join()


class DownloadTests(unittest.TestCase):
    def test_interrupted_download_resumes_correct_prefix(self):
        payload = bytes(range(256)) * 400
        with tempfile.TemporaryDirectory() as directory, ArchiveServer(payload, 'truncated') as server:
            path = Path(directory) / 'source.zip'
            with self.assertRaisesRegex(mod.ImportFailure, 'truncated'): mod.download_archive(server.sheet(), path)
            self.assertEqual(path.with_name(path.name + '.part').read_bytes(), payload[:17])
            server.mode = 'valid'
            with mock.patch.object(mod, 'CHUNK', 16384): result = mod.download_archive(server.sheet(), path)
            self.assertEqual(result.read_bytes(), payload)
            self.assertEqual(server.ranges[1][0], 17)
            self.assertTrue(all(item[2] == '"fixture"' for item in server.ranges))

    def test_bad_ranges_never_append_body(self):
        for mode in ('ignored', 'bad-range', 'changed'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory, ArchiveServer(b'x' * 100, mode) as server:
                path = Path(directory) / 'source.zip'
                with self.assertRaises(mod.ImportFailure): mod.download_archive(server.sheet(), path)
                self.assertEqual(path.with_name(path.name + '.part').stat().st_size, 0)

    def test_unidentified_partial_refused_complete_local_seed_adopted(self):
        with tempfile.TemporaryDirectory() as directory, ArchiveServer(b'complete source') as server:
            path = Path(directory) / 'source.zip'; partial = path.with_name(path.name + '.part')
            partial.write_bytes(b'part')
            with self.assertRaisesRegex(mod.ImportFailure, 'identity'): mod.download_archive(server.sheet(), path)
            partial.write_bytes(server.payload)
            self.assertEqual(mod.download_archive(server.sheet(), path), partial)
            self.assertEqual(server.ranges, [])

    def test_source_change_cannot_resume_old_bytes(self):
        with tempfile.TemporaryDirectory() as directory, ArchiveServer(b'x' * 100) as server:
            path = Path(directory) / 'source.zip'
            path.with_name(path.name + '.part').write_bytes(b'x' * 10)
            mod.atomic_json(path.with_name(path.name + '.part.json'), {**mod.source_identity(server.sheet()), 'etag': '"old"'})
            with self.assertRaisesRegex(mod.ImportFailure, 'different source'): mod.download_archive(server.sheet(), path)
            self.assertEqual(server.ranges, [])


class ZipTests(unittest.TestCase):
    def check_zip(self, payload, stem=STEM):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.zip'; path.write_bytes(payload)
            sheet = {'url': f'https://portal.spatial.nsw.gov.au/download/contours/56/{stem}.zip'}
            return mod.verify_archive(path, sheet)
    def test_crc_and_checksum(self):
        payload = fixture_zip(); result = self.check_zip(payload)
        self.assertEqual(len(result['sha256']), 64)
        self.assertEqual(len(result['members']), 4)
        bad = bytearray(payload); bad[30 + len(STEM + '.shp')] ^= 1
        with self.assertRaisesRegex(mod.ImportFailure, 'CRC'): self.check_zip(bytes(bad))
    def test_traversal_symlink_and_expansion_bomb(self):
        link = zipfile.ZipInfo('unsafe.txt'); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for extra in (('../escape.txt', b'escape'), (link, b'/outside'), ('bomb.txt', b'0' * (2 * mod.MIB))):
            with self.subTest(name=str(extra[0])), self.assertRaises(mod.ImportFailure):
                self.check_zip(fixture_zip(extra, zipfile.ZIP_DEFLATED))

    def test_official_arumpo_double_prefix_is_flattened_with_original_provenance(self):
        stem = 'Arumpo-CONT-AHD_54_2m'
        prefix = stem + '/' + stem + '/'
        # The real archive has one zero-byte DOS directory entry for this
        # double prefix, without a separate outer directory entry.
        directory = zipfile.ZipInfo(prefix); directory.create_system = 0; directory.external_attr = 0x10
        metadata = prefix + 'Western-CONT-AHD_54_2m_Metadata.html'
        payload = fixture_zip((metadata, b'official metadata fixture'), zipfile.ZIP_DEFLATED,
                              stem=stem, prefix=prefix, directories=[directory])
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); source = folder / 'source.zip'; source.write_bytes(payload)
            stage = folder / 'stage'; stage.mkdir()
            sheet = {'url': f'https://portal.spatial.nsw.gov.au/download/contours/54/{stem}.zip'}
            verified = mod.verify_archive(source, sheet)
            self.assertEqual({entry['name'] for entry in verified['members']},
                             {prefix, metadata, *(prefix + stem + suffix for suffix in ('.shp', '.shx', '.dbf', '.prj'))})
            mod.extract_shapefile(source, sheet, stage)
            self.assertEqual({entry.name for entry in stage.iterdir()}, {stem + suffix for suffix in ('.shp', '.shx', '.dbf', '.prj')})
            self.assertEqual((stage / (stem + '.shp')).read_bytes(), b'fixture contents .shp')
            self.assertTrue(all(entry.is_file() for entry in stage.iterdir()))

    def test_one_common_stem_prefix_and_optional_ancestor_directories(self):
        for depth, explicit in ((1, False), (1, True), (2, False), (2, True)):
            prefix = (STEM + '/') * depth
            directories = [(STEM + '/') * level for level in range(1, depth + 1)] if explicit else []
            with self.subTest(depth=depth, explicit=explicit):
                verified = self.check_zip(fixture_zip(prefix=prefix, directories=directories))
                self.assertEqual(len(verified['members']), 4 + len(directories))

    def test_nested_layout_rejects_unsafe_paths_mixed_prefixes_and_duplicate_basenames(self):
        prefix = (STEM + '/') * 2
        link = zipfile.ZipInfo(prefix + 'link.txt'); link.create_system = 3; link.external_attr = (stat.S_IFLNK | 0o777) << 16
        directory_link = zipfile.ZipInfo(prefix); directory_link.create_system = 3; directory_link.external_attr = (stat.S_IFLNK | 0o777) << 16
        extras = [('/escape.txt', b'x'), ('../escape.txt', b'x'), ('C:\\escape.txt', b'x'),
                  (prefix + '..\\escape.txt', b'x'), (prefix + '../escape.txt', b'x'), (STEM + '//notes.txt', b'x'),
                  (prefix + STEM + '/notes.txt', b'x'), ('Other/notes.txt', b'x'), ('notes.txt', b'x'),
                  (STEM + '/notes.txt', b'x'), (STEM + '/' + STEM + '/./notes.txt', b'x'),
                  (prefix + STEM + '.DBF', b'x'), (link, b'/outside'), (directory_link, b''), (prefix, b'not empty')]
        for extra in extras:
            with self.subTest(name=str(extra[0])), tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary); source = folder / 'source.zip'; source.write_bytes(fixture_zip(extra, prefix=prefix))
                stage = folder / 'stage'; stage.mkdir()
                sheet = {'url': f'https://portal.spatial.nsw.gov.au/download/contours/56/{STEM}.zip'}
                with self.assertRaises(mod.ImportFailure): mod.extract_shapefile(source, sheet, stage)
                self.assertEqual(list(stage.iterdir()), [], 'validate every member before writing any extracted file')
        # Directory entries must be ancestors of the single file prefix.
        with self.assertRaises(mod.ImportFailure):
            self.check_zip(fixture_zip(directories=[STEM + '/']))
        with self.assertRaises(mod.ImportFailure):
            self.check_zip(fixture_zip(prefix=STEM + '/', directories=[prefix]))


def varint(data, position):
    value, shift = 0, 0
    while True:
        byte = data[position]; position += 1; value |= (byte & 127) << shift
        if byte < 128: return value, position
        shift += 7


def fields(data):
    position = 0
    while position < len(data):
        tag, position = varint(data, position); number, wire = tag >> 3, tag & 7
        if wire == 0: value, position = varint(data, position)
        elif wire in (1, 2, 5):
            size, position = varint(data, position) if wire == 2 else (8 if wire == 1 else 4, position)
            value = data[position:position + size]; position += size
        else: raise AssertionError('Unexpected protobuf wire type')
        yield number, wire, value


def tile_elevations(data):
    if data[:2] == b'\x1f\x8b': data = gzip.decompress(data)
    result = set()
    for number, _, layer in fields(data):
        if number != 3: continue
        entries = list(fields(layer)); keys = [v.decode() for k, _, v in entries if k == 3]; values = []
        for number, _, value in entries:
            if number != 4: continue
            kind, wire, val = next(fields(value))
            values.append(struct.unpack('<d' if kind == 3 else '<f', val)[0] if wire in (1, 5) else
                          ((val >> 1) ^ -(val & 1)) if kind == 6 else val)
        for number, _, feature in entries:
            if number != 2: continue
            for feature_field, _, tags in fields(feature):
                if feature_field != 2: continue
                numbers, pos = [], 0
                while pos < len(tags):
                    value, pos = varint(tags, pos); numbers.append(value)
                for i in range(0, len(numbers), 2):
                    if keys[numbers[i]] == 'elevation': result.add(values[numbers[i + 1]])
    return result


class AssemblyProgressTests(unittest.TestCase):
    def test_real_counters_stage_changes_rates_stalls_and_final_file_move(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); output = root / 'map.mbtiles'; log = root / 'join.log'
            clock = [0]
            progress = mod.AssemblyProgress(output, log, 2, 1000, clock=lambda: clock[0])
            def write(stage, files, inputs, outputs, size):
                log.write_text('16/60000/39000\r\nQTOPO_ASSEMBLY ' + json.dumps({
                    'stage': stage, 'checkedFiles': files, 'inputTiles': inputs, 'outputTiles': outputs,
                    'privatePath': '/private/not-public'}) + '\n')
                with output.open('wb') as stream: stream.truncate(size)
            first = progress.sample(force=True)
            self.assertEqual(first['stage'], 'checking-inputs')
            self.assertFalse(first['countersAvailable'])
            write('checking-inputs', 1, 0, 0, 0)
            clock[0] = 5
            self.assertEqual(progress.sample()['checkedFiles'], 1)
            write('merging', 2, 100, 50, 1000)
            clock[0] = 10
            self.assertNotIn('etaSeconds', progress.sample())
            write('merging', 2, 450, 250, 5000)
            clock[0] = 45
            sample = progress.sample()
            self.assertEqual(sample['inputTiles'], 450)
            self.assertEqual(sample['outputTiles'], 250, 'overlapping input tiles must not be confused with output tiles')
            self.assertEqual(sample['tilesPerSecond'], 10)
            self.assertEqual(sample['etaSeconds'], 55)
            self.assertNotIn('privatePath', sample)
            clock[0] = 180
            stalled = progress.sample()
            self.assertEqual(stalled['tilesPerSecond'], 0)
            self.assertNotIn('etaSeconds', stalled, 'a stalled merge must not retain a misleading old ETA')
            write('merged', 2, 1000, 600, 10000)
            clock[0] = 185
            checked = progress.sample(force=True, stage='validating')
            self.assertEqual(checked['inputTiles'], 1000)
            self.assertNotIn('etaSeconds', checked)
            progress.sample(force=True, stage='hashing', hashed_bytes=0)
            clock[0] = 220
            hashed = progress.sample(hashed_bytes=3500)
            self.assertEqual(hashed['hashBytesPerSecond'], 100)
            self.assertEqual(hashed['etaSeconds'], 65)
            output.rename(root / 'published.mbtiles')
            final = progress.sample(force=True, stage='complete', hashed_bytes=10000)
            self.assertEqual(final['outputBytes'], 10000)
            self.assertNotIn('etaSeconds', final)

    def test_partial_invalid_and_decreasing_native_records_do_not_replace_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); log = root / 'join.log'
            progress = mod.AssemblyProgress(root / 'output', log, 2, 1000)
            good = {'stage': 'merging', 'checkedFiles': 2, 'inputTiles': 500, 'outputTiles': 250}
            log.write_text('QTOPO_ASSEMBLY ' + json.dumps(good) + '\n')
            self.assertEqual(progress.sample(force=True)['inputTiles'], 500)
            for patch in ({'inputTiles': 1001}, {'inputTiles': -1}, {'inputTiles': True}, {'inputTiles': 200}, {'stage': 'secret'}):
                with log.open('a') as stream: stream.write('QTOPO_ASSEMBLY ' + json.dumps({**good, **patch}) + '\n')
            with log.open('a') as stream: stream.write('QTOPO_ASSEMBLY {"stage":')
            sample = progress.sample(force=True)
            self.assertEqual(sample['inputTiles'], 500)
            self.assertEqual(sample['stage'], 'merging')


@unittest.skipUnless(all(shutil.which(n) for n in ('ogr2ogr', 'tippecanoe', 'tile-join')), 'Native tools are not installed')
class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name); source = self.folder / 'source.geojson'
        source.write_text(json.dumps({'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'properties': {'Elevation': height}, 'geometry': {'type': 'LineString', 'coordinates':
             [[150.313, -33.677 + index * .0003], [150.315, -33.677 + index * .0003]]}}
            for index, height in enumerate((100, 110, 112))]}))
        subprocess.run([shutil.which('ogr2ogr'), '-f', 'ESRI Shapefile', '-t_srs', 'EPSG:28356',
                        str(self.folder / (STEM + '.shp')), str(source)], check=True, capture_output=True)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in self.folder.glob(STEM + '.*'): archive.write(path, path.name)
        self.payload = stream.getvalue(); self.catalog = self.folder / 'catalog.json'; self.store = self.folder / 'store'
    def write_catalog(self, sheets):
        self.catalog.write_text(json.dumps({'format': 1, 'sourceUrl': 'offline fixture', 'checkedAt': '2026-11-27', 'sheets': sheets}))
    def assert_native_progress(self, result):
        if os.environ.get('QTOPO_REQUIRE_ASSEMBLY_PROGRESS') != '1':
            return
        progress = mod.read_json(self.store / 'status.json')['assembly']
        self.assertTrue(progress['countersAvailable'], 'Docker must use the instrumented pinned tile-join')
        self.assertEqual(progress['stage'], 'complete')
        self.assertEqual(progress['checkedFiles'], result['sheets'])
        self.assertEqual(progress['inputTiles'], progress['totalInputTiles'])
        self.assertEqual(progress['outputTiles'], result['tiles'])
        self.assertEqual(progress['outputBytes'], result['fileBytes'])
    def test_native_zoom_rules_atomic_publish_restart_without_network(self):
        with ArchiveServer(self.payload) as server:
            self.write_catalog([server.sheet()]); first = mod.Importer(self.store, self.catalog, 0, threads=1); result = first.run()
            self.assertEqual(mod.read_json(self.store / 'current.json'), result)
            self.assertEqual(mod.read_json(self.store / 'published' / (result['revision'] + '.json')), result)
            self.assertEqual(mod.read_json(self.store / 'status.json')['phase'], 'ready')
            self.assert_native_progress(result)
            by_zoom = {}
            with sqlite3.connect(self.store / result['file']) as database:
                for zoom, tile in database.execute('SELECT zoom_level,tile_data FROM tiles'):
                    by_zoom.setdefault(zoom, set()).update(tile_elevations(tile))
            for zoom, expected in ((10, {100}), (12, {100, 110}), (15, {100, 110, 112}), (16, {100, 110, 112})):
                self.assertEqual(by_zoom[zoom], expected)
            requests = list(server.ranges)
            self.assertEqual(mod.Importer(self.store, self.catalog, 0, threads=1).run(), result)
            self.assertEqual(server.ranges, requests)
            self.assertTrue(first.archive_path(server.sheet()).is_file())
            self.assertEqual(list((self.store / 'work').iterdir()), [])

    def test_nested_archive_builds_native_tiles_and_retains_original_member_paths(self):
        prefix = (STEM + '/') * 2
        stream = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(self.payload)) as source, zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
            directory = zipfile.ZipInfo(prefix); directory.create_system = 0; directory.external_attr = 0x10
            archive.writestr(directory, b'')
            for entry in source.infolist(): archive.writestr(prefix + entry.filename, source.read(entry))
            archive.writestr(prefix + 'Western-CONT-AHD_54_2m_Metadata.html', b'fixture metadata')
        with ArchiveServer(stream.getvalue()) as server:
            self.write_catalog([server.sheet()])
            importer = mod.Importer(self.store, self.catalog, 0, threads=1)
            result = importer.run()
            with sqlite3.connect(self.store / result['file']) as database:
                heights = set()
                for tile, in database.execute('SELECT tile_data FROM tiles WHERE zoom_level = 16'):
                    heights.update(tile_elevations(tile))
            self.assertEqual(heights, {100, 110, 112})
            retained = mod.read_json(importer.archive_path(server.sheet()).with_suffix('.json'))
            self.assertEqual(len(retained['members']), 6)
            self.assertTrue(all(entry['name'].startswith(prefix) for entry in retained['members']))
            self.assertEqual(list((self.store / 'work').iterdir()), [])

    def test_failed_later_sheet_preserves_current_and_completed_work(self):
        with ArchiveServer(self.payload) as server:
            sheets = [server.sheet('first'), server.sheet('second')]; self.write_catalog(sheets)
            importer = mod.Importer(self.store, self.catalog, 0, threads=1)
            old = {'revision': 'old', 'file': 'published/old.mbtiles'}; mod.atomic_json(self.store / 'current.json', old)
            original = mod.Importer.prepare_sheet
            def fail_second(instance, sheet, *args):
                if sheet['id'] == 'second': raise mod.ImportFailure('fixture preparation failure')
                return original(instance, sheet, *args)
            with mock.patch.object(mod.Importer, 'prepare_sheet', fail_second), self.assertRaisesRegex(mod.ImportFailure, 'fixture'):
                importer.run()
            self.assertEqual(mod.read_json(self.store / 'current.json'), old)
            first_path, _ = importer.prepared_paths(sheets[0]); stamp = first_path.stat().st_mtime_ns; requests = list(server.ranges)
            result = mod.Importer(self.store, self.catalog, 0, threads=1).run()
            self.assertEqual(result['sheets'], 2)
            self.assert_native_progress(result)
            self.assertEqual(first_path.stat().st_mtime_ns, stamp)
            self.assertEqual(server.ranges, requests)
            self.assertEqual(mod.read_json(self.store / 'current.json')['revision'], result['revision'])

    def test_waiting_for_space_does_not_download_or_replace_current(self):
        with ArchiveServer(self.payload) as server:
            self.write_catalog([server.sheet()])
            importer = mod.Importer(self.store, self.catalog, 1000, threads=1)
            old = {'revision': 'old'}
            mod.atomic_json(self.store / 'current.json', old)
            with mock.patch.object(mod.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(1000, 1000, 0)), \
                    self.assertRaises(mod.WaitingSpace):
                importer.run()
            self.assertEqual(server.ranges, [])
            self.assertEqual(mod.read_json(self.store / 'current.json'), old)
            self.assertEqual(mod.read_json(self.store / 'status.json')['phase'], 'waiting-space')


if __name__ == '__main__': unittest.main()

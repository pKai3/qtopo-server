#!/usr/bin/env python3
"""Retain NSW derived 2 m contour sources and atomically publish complete MBTiles."""
import argparse
import contextlib
import datetime as dt
import errno
import fcntl
import hashlib
import http.client
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

MIB = 1024 * 1024
CHUNK = 8 * MIB
MAX_EXPANDED_BYTES = 32 * 1024 ** 3
MAX_FEATURE_BYTES = 128 * MIB
RECIPE = {'version': 1, 'layer': 'contours', 'minzoom': 10, 'maxzoom': 16,
          'intervalZooms': [[50, 10], [10, 12], [2, 15]], 'detail': 12}
ATTRIBUTION = '© State of New South Wales (Spatial Services). CC BY 3.0 AU.'


class ImportFailure(Exception):
    pass


class WaitingSpace(ImportFailure):
    pass


class Interrupted(ImportFailure):
    pass


class AlreadyRunning(ImportFailure):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode='w', prefix='.' + path.name + '-', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(descriptor)


def durable_replace(source, destination):
    with Path(source).open('rb') as stream:
        os.fsync(stream.fileno())
    os.replace(source, destination)
    sync_directory(Path(destination).parent)


def read_json(path):
    with Path(path).open() as stream:
        return json.load(stream)


def fingerprint(path):
    info = Path(path).stat()
    return {'bytes': info.st_size, 'mtimeNs': info.st_mtime_ns}


def sha256(path, guard=lambda: None):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while chunk := stream.read(MIB):
            guard()
            result.update(chunk)
    return result.hexdigest()


def regular_file(path):
    return Path(path).is_file() and not Path(path).is_symlink()


def load_catalog(path):
    catalog = read_json(path)
    if catalog.get('format') != 1 or not isinstance(catalog.get('sheets'), list) or not catalog['sheets']:
        raise ImportFailure('Catalogue must have format 1 and at least one sheet.')
    ids = set()
    for sheet in catalog['sheets']:
        identifier = sheet.get('id', '')
        if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,149}', identifier) or '..' in identifier:
            raise ImportFailure('Unsafe sheet identifier in catalogue.')
        if identifier in ids:
            raise ImportFailure('Duplicate sheet identifier in catalogue.')
        ids.add(identifier)
        zone = str(sheet.get('zone', ''))
        if zone not in ('54', '55', '56', '57'):
            raise ImportFailure(f'Invalid MGA zone for {identifier}.')
        sheet['zone'] = zone
        url = urllib.parse.urlsplit(sheet.get('url', ''))
        # Loopback permits offline integration fixtures; the shipped catalogue uses the fixed NSW host.
        local = url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')
        official = url.scheme == 'https' and url.hostname == 'portal.spatial.nsw.gov.au' and url.path.startswith('/download/contours/' + zone + '/')
        if not (local or official) or url.username or url.password or url.fragment or url.query:
            raise ImportFailure(f'Unexpected contour source URL for {identifier}.')
        name = urllib.parse.unquote(PurePosixPath(url.path).name)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_. -]{0,180}\.zip', name) or '..' in name:
            raise ImportFailure(f'Unsafe source archive name for {identifier}.')
        if not isinstance(sheet.get('bytes'), int) or isinstance(sheet['bytes'], bool) or not 0 < sheet['bytes'] <= 64 * 1024 ** 3:
            raise ImportFailure(f'Invalid archive size for {identifier}.')
        etag = sheet.get('etag')
        if not isinstance(etag, str) or not etag or len(etag) > 256 or '\r' in etag or '\n' in etag or etag.startswith('W/'):
            raise ImportFailure(f'A pinned strong ETag is required for {identifier}.')
        bounds = sheet.get('bounds')
        if not isinstance(bounds, list) or len(bounds) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in bounds):
            raise ImportFailure(f'Invalid bounds for {identifier}.')
        west, south, east, north = bounds
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ImportFailure(f'Invalid bounds for {identifier}.')
        if not isinstance(sheet.get('name'), str):
            raise ImportFailure(f'Missing sheet name for {identifier}.')
    catalog['sheets'].sort(key=lambda sheet: sheet['id'])
    return catalog


def source_identity(sheet):
    return {key: sheet[key] for key in ('url', 'bytes', 'etag')}


def archive_filename(sheet):
    return f"{sheet['id']}-{digest_json(source_identity(sheet))[:16]}.zip"


def prepared_key(sheet):
    return digest_json({'source': source_identity(sheet), 'recipe': RECIPE})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None  # The default handler consumes redirect bodies without a download bound.


OPENER = urllib.request.build_opener(NoRedirect)


def open_source(request):
    try:
        return OPENER.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        error.close()
        raise ImportFailure(f'Contour source returned HTTP {error.code}.') from error
    except (OSError, http.client.HTTPException) as error:
        raise ImportFailure(f'Contour source could not be reached: {error}') from error


def check_head(sheet):
    request = urllib.request.Request(sheet['url'], method='HEAD', headers={'Accept-Encoding': 'identity'})
    with open_source(request) as response:
        if response.status != 200 or response.headers.get('Content-Length') != str(sheet['bytes']) or response.headers.get('ETag') != sheet['etag']:
            raise ImportFailure('Source size or ETag differs from the pinned catalogue; refresh the catalogue before continuing.')


def download_archive(sheet, destination, guard=lambda needed=0: None, progress=lambda count: None):
    """Retain a valid prefix on interruption; no response body is read before its range is checked."""
    destination = Path(destination)
    partial = destination.with_name(destination.name + '.part')
    marker = partial.with_name(partial.name + '.json')
    identity = source_identity(sheet)
    for path in (destination, partial, marker):
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ImportFailure('Archive paths must be regular files.')
    if destination.exists():
        if destination.stat().st_size != sheet['bytes']:
            raise ImportFailure(f'Retained archive has the wrong size: {destination.name}')
        return destination
    size = partial.stat().st_size if partial.exists() else 0
    if size > sheet['bytes']:
        raise ImportFailure('Partial archive is larger than its pinned source.')
    if marker.exists():
        if read_json(marker) != identity:
            raise ImportFailure('Partial archive belongs to a different source version.')
    elif size and size != sheet['bytes']:
        raise ImportFailure('Partial archive has no source identity; refusing an unsafe resume.')
    # A complete local seed can be adopted, but is CRC checked by the caller before publication.
    if size == sheet['bytes']:
        return partial
    check_head(sheet)
    atomic_json(marker, identity)
    with partial.open('ab') as stream:
        while size < sheet['bytes']:
            count = min(CHUNK, sheet['bytes'] - size)
            guard(count)
            end = size + count - 1
            request = urllib.request.Request(sheet['url'], headers={'Range': f'bytes={size}-{end}', 'If-Match': sheet['etag'], 'Accept-Encoding': 'identity'})
            try:
                with open_source(request) as response:
                    expected = f"bytes {size}-{end}/{sheet['bytes']}"
                    if response.status != 206 or response.headers.get('Content-Range') != expected:
                        raise ImportFailure('Source ignored the requested range or returned an unexpected Content-Range.')
                    if response.headers.get('Content-Length') != str(count) or response.headers.get('ETag') != sheet['etag']:
                        raise ImportFailure('Range length or source ETag changed during download.')
                    if response.headers.get('Content-Encoding', 'identity').lower() != 'identity' or response.headers.get('Transfer-Encoding'):
                        raise ImportFailure('Unexpected encoded range response.')
                    left = count
                    deadline = time.monotonic() + 120
                    while left:
                        guard()
                        if time.monotonic() > deadline:
                            raise ImportFailure('Archive range download timed out.')
                        data = response.read1(min(65536, left))
                        if not data:
                            raise ImportFailure('Archive range was truncated; the valid prefix has been retained.')
                        stream.write(data)
                        left -= len(data)
                        size += len(data)
                        progress(len(data))
                    stream.flush()
                    os.fsync(stream.fileno())
            except (OSError, http.client.HTTPException) as error:
                raise ImportFailure(f'Archive download interrupted; prefix retained: {error}') from error
    return partial


def zip_members(path, sheet):
    """Allow flat files or one common one/two-stem prefix, before decompressing anything."""
    expected = PurePosixPath(urllib.parse.unquote(urllib.parse.urlsplit(sheet['url']).path)).stem
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not 4 <= len(members) <= 16:
                raise ImportFailure('Unexpected number of files in contour archive.')
            seen, paths, directories = set(), set(), []
            prefix = None
            allowed_prefixes = ((), (expected,), (expected, expected))
            required = {expected + suffix for suffix in ('.shp', '.shx', '.dbf', '.prj')}
            expanded = 0
            for member in members:
                name = member.filename
                mode = member.external_attr >> 16
                if name != member.orig_filename or name in paths:
                    raise ImportFailure('Unsafe archive entry or duplicate filename.')
                paths.add(name)
                if member.flag_bits & 1 or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ImportFailure('Encrypted or unsupported ZIP entry.')
                if member.file_size > 16 * 1024 ** 3 or member.file_size > max(1, member.compress_size) * 1000:
                    raise ImportFailure('ZIP expansion limit exceeded.')
                if member.is_dir():
                    directory = tuple(name[:-1].split('/'))
                    if (directory not in allowed_prefixes[1:] or member.file_size or member.CRC
                            or stat.S_IFMT(mode) not in (0, stat.S_IFDIR)):
                        raise ImportFailure('Unsafe contour archive directory.')
                    directories.append(directory)
                    continue
                parts = name.split('/')
                parent, basename = tuple(parts[:-1]), parts[-1]
                if (parent not in allowed_prefixes or (prefix is not None and parent != prefix)
                        or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_. -]{0,219}', basename) or '..' in basename
                        or basename.casefold() in seen or stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                    raise ImportFailure('Unsafe archive entry, mixed directory prefixes or duplicate filename.')
                prefix = parent
                seen.add(basename.casefold())
                suffix = PurePosixPath(basename).suffix.lower()
                if basename not in required and suffix not in ('.html', '.htm', '.xml', '.txt', '.cpg', '.sbn', '.sbx'):
                    raise ImportFailure(f'Unexpected contour archive entry: {name}')
                expanded += member.file_size
            if any(prefix is None or prefix[:len(directory)] != directory for directory in directories):
                raise ImportFailure('Mixed contour archive directory prefixes.')
            if not {name.casefold() for name in required}.issubset(seen) or expanded > MAX_EXPANDED_BYTES:
                raise ImportFailure('Missing shapefile components or excessive expanded archive size.')
            return members, expanded, expected
    except (zipfile.BadZipFile, OSError) as error:
        raise ImportFailure(f'Invalid contour ZIP: {error}') from error


def verify_archive(path, sheet, guard=lambda: None):
    members, expanded, stem = zip_members(path, sheet)
    try:
        with zipfile.ZipFile(path) as archive:
            for member in members:
                with archive.open(member) as stream:
                    while stream.read(MIB):
                        guard()  # Reaching EOF verifies every member's CRC, including metadata.
    except (zipfile.BadZipFile, EOFError, OSError) as error:
        raise ImportFailure(f'Archive CRC verification failed: {error}') from error
    return {'sha256': sha256(path, guard), 'expandedBytes': expanded, 'stem': stem,
            'members': [{'name': m.filename, 'bytes': m.file_size, 'compressedBytes': m.compress_size, 'crc32': f'{m.CRC:08x}'} for m in members]}


def extract_shapefile(path, sheet, destination, guard=lambda _bytes: None):
    # Validate the complete layout before creating files. Original paths remain
    # in archive provenance; only safe unique basenames enter the tool workspace.
    members, _, _ = zip_members(path, sheet)
    with zipfile.ZipFile(path) as archive:
        for member in members:
            basename = PurePosixPath(member.filename).name
            if member.is_dir() or PurePosixPath(basename).suffix.lower() not in ('.shp', '.shx', '.dbf', '.prj', '.cpg'):
                continue
            with archive.open(member) as src, (destination / basename).open('xb') as dst:
                while chunk := src.read(MIB):
                    guard(len(chunk))
                    dst.write(chunk)


def contour_feature(feature):
    if (not isinstance(feature, dict) or feature.get('type') != 'Feature' or not isinstance(feature.get('geometry'), dict)
            or feature['geometry'].get('type') not in ('LineString', 'MultiLineString')):
        raise ImportFailure('Contour source contains missing or non-line geometry.')
    elevation = (feature.get('properties') or {}).get('Elevation')
    if isinstance(elevation, bool) or not isinstance(elevation, (int, float)) or not math.isfinite(elevation) or abs(elevation) > 10000:
        raise ImportFailure('Contour source has a missing or non-numeric Elevation.')
    if abs(elevation / 2 - round(elevation / 2)) > 1e-6:
        raise ImportFailure('Contour elevation is not on the expected 2 metre interval.')
    elevation = int(round(elevation))
    feature['properties'] = {'elevation': elevation}
    feature['tippecanoe'] = {'minzoom': 10 if elevation % 50 == 0 else 12 if elevation % 10 == 0 else 15}
    feature.pop('id', None)
    return feature


def mbtiles_info(path):
    try:
        with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ImportFailure('MBTiles failed SQLite integrity checking.')
            metadata = dict(connection.execute('SELECT name,value FROM metadata'))
            count, maximum = connection.execute('SELECT count(*),max(length(tile_data)) FROM tiles').fetchone()
            layers = json.loads(metadata.get('json', '{}')).get('vector_layers', [])
            if (not count or metadata.get('format') != 'pbf' or metadata.get('minzoom') != '10' or metadata.get('maxzoom') != '16'
                    or len(layers) != 1 or layers[0].get('id') != 'contours' or 'elevation' not in layers[0].get('fields', {})):
                raise ImportFailure('MBTiles has an unexpected layer, zoom range or missing elevation data.')
            return {'tiles': count, 'maxTileBytes': maximum, 'fileBytes': Path(path).stat().st_size}
    except (sqlite3.Error, ValueError, KeyError, OSError) as error:
        raise ImportFailure(f'Could not validate prepared MBTiles: {error}') from error


class Importer:
    def __init__(self, data_dir, catalog_path, min_free_bytes, threads=8):
        if min_free_bytes < 0 or not 1 <= threads <= 64:
            raise ImportFailure('Free-space threshold must be nonnegative and threads must be between 1 and 64.')
        self.root, self.catalog_path = Path(data_dir).absolute(), Path(catalog_path)
        self.min_free, self.threads = min_free_bytes, threads
        self.stop = threading.Event()
        self.failure = None
        self.children = set()
        self.children_lock = threading.Lock()
        self.monitor_done = threading.Event()
        self.state = {'phase': 'preparing', 'completedSheets': 0, 'totalSheets': 0, 'downloadedBytes': 0, 'totalBytes': 0, 'currentSheet': None}
        self.last_status = 0
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ('archives', 'prepared', 'published', 'work'):
            path = self.root / name
            if path.is_symlink():
                raise ImportFailure('Importer storage directories must not be symlinks.')
            path.mkdir(exist_ok=True)
        self.env = {**os.environ, 'TIPPECANOE_MAX_THREADS': str(threads), 'GDAL_NUM_THREADS': str(threads)}

    def guard(self, needed=0):
        if self.failure:
            raise self.failure
        if self.stop.is_set():
            raise Interrupted('Preparation stopped; retained downloads and completed sheets will resume next time.')
        free = shutil.disk_usage(self.root).free
        if free < self.min_free + needed:
            self.state.update(freeBytes=free, requiredFreeBytes=self.min_free + needed)
            raise WaitingSpace(f'Waiting for disk space: need {self.min_free + needed} free bytes; have {free}.')

    def status(self, force=True, **changes):
        self.state.update(changes)
        if force or time.monotonic() - self.last_status >= 1:
            atomic_json(self.root / 'status.json', {**self.state, 'updatedAt': utc_now()})
            self.last_status = time.monotonic()

    @contextlib.contextmanager
    def lock(self):
        descriptor = os.open(self.root / 'import.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise AlreadyRunning('Another NSW contour importer is already running.') from error
            os.ftruncate(descriptor, 0)
            os.write(descriptor, f'{os.getpid()}\n'.encode())
            yield
        finally:
            os.close(descriptor)

    def monitor(self):
        while not self.monitor_done.wait(0.5):
            with self.children_lock:
                children = list(self.children)
            if not children:
                continue
            try:
                self.guard()
            except ImportFailure as error:
                self.failure = error
                for child in children:
                    self.terminate(child)

    @staticmethod
    def terminate(child):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            except ProcessLookupError:
                pass

    @contextlib.contextmanager
    def process(self, command, **kwargs):
        self.guard()
        child = subprocess.Popen(command, env=self.env, start_new_session=True, **kwargs)
        with self.children_lock:
            self.children.add(child)
        try:
            yield child
        finally:
            self.terminate(child)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None:
                    with contextlib.suppress(OSError):
                        stream.close()
            with self.children_lock:
                self.children.discard(child)

    def check_process(self, child, log):
        while child.poll() is None:
            self.guard()
            try:
                child.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
        self.guard()
        if child.returncode:
            with Path(log).open('rb') as stream:
                stream.seek(max(0, Path(log).stat().st_size - 3000))
                detail = stream.read().decode(errors='replace')
            raise ImportFailure(f'Contour preparation tool failed: {detail.strip()}')

    def archive_path(self, sheet):
        return self.root / 'archives' / archive_filename(sheet)

    def ensure_archive(self, sheet):
        destination = self.archive_path(sheet)
        manifest_path = destination.with_suffix('.json')
        def progress(count):
            self.state['downloadedBytes'] += count
            self.status(force=False)
        self.status(phase='downloading', message='Retaining the official source archive.')
        source = download_archive(sheet, destination, self.guard, progress)
        saved = read_json(manifest_path) if manifest_path.exists() else None
        if source == destination and saved and saved.get('source') == source_identity(sheet) and saved.get('fingerprint') == fingerprint(source):
            return destination, saved
        self.status(phase='preparing', message='Verifying every archive member and its checksum.')
        verified = verify_archive(source, sheet, self.guard)
        if source != destination:
            durable_replace(source, destination)
            source.with_name(source.name + '.json').unlink(missing_ok=True)
        saved = {**verified, 'source': source_identity(sheet), 'fingerprint': fingerprint(destination), 'verifiedAt': utc_now()}
        atomic_json(manifest_path, saved)
        return destination, saved

    def prepared_paths(self, sheet):
        stem = self.root / 'prepared' / f"{sheet['id']}-{prepared_key(sheet)}"
        return Path(str(stem) + '.mbtiles'), Path(str(stem) + '.json')

    def reusable_sheet(self, sheet):
        path, manifest = self.prepared_paths(sheet)
        if not regular_file(path) or not regular_file(manifest):
            return None
        saved = read_json(manifest)
        if saved.get('key') != prepared_key(sheet) or saved.get('fingerprint') != fingerprint(path):
            return None
        return saved

    def prepare_sheet(self, sheet, archive, verified):
        path, manifest = self.prepared_paths(sheet)
        # Expanded source plus sorting/output workspace, in addition to the user's free-space floor.
        self.guard(3 * verified['expandedBytes'] + sheet['bytes'])
        self.status(phase='preparing', message='Preparing retained vector tiles for this map sheet.')
        with tempfile.TemporaryDirectory(prefix='sheet-', dir=self.root / 'work') as temporary:
            stage = Path(temporary)
            extract_shapefile(archive, sheet, stage, self.guard)
            output = stage / 'tiles.mbtiles'
            tip_command = [self.tools['tippecanoe'], '-o', str(output), '-l', 'contours', '-Z', '10', '-z', '16',
                           '-d', '12', '-pk', '-pf', '-pS', '-r', '1', '-y', 'elevation', '-t', str(stage), '-Q']
            ogr_command = [self.tools['ogr2ogr'], '-f', 'GeoJSONSeq', '/vsistdout/', str(stage / (verified['stem'] + '.shp')),
                           '-t_srs', 'EPSG:4326', '-dim', 'XY', '-select', 'Elevation', '-lco', 'RS=NO', '-lco', 'COORDINATE_PRECISION=7']
            count, minimum, maximum = 0, None, None
            ogr_log, tip_log = stage / 'ogr.log', stage / 'tippecanoe.log'
            with ogr_log.open('wb') as ogr_err, tip_log.open('wb') as tip_err, \
                    self.process(tip_command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=tip_err) as tip, \
                    self.process(ogr_command, stdout=subprocess.PIPE, stderr=ogr_err) as ogr:
                try:
                    while line := ogr.stdout.readline(MAX_FEATURE_BYTES + 1):
                        self.guard()
                        if len(line) > MAX_FEATURE_BYTES:
                            raise ImportFailure('A contour feature exceeds the bounded streaming record size.')
                        feature = contour_feature(json.loads(line.lstrip(b'\x1e')))
                        height = feature['properties']['elevation']
                        minimum = height if minimum is None else min(minimum, height)
                        maximum = height if maximum is None else max(maximum, height)
                        tip.stdin.write(json.dumps(feature, separators=(',', ':'), allow_nan=False).encode() + b'\n')
                        count += 1
                        self.status(force=False, featuresPrepared=count)
                    tip.stdin.close()
                    self.check_process(ogr, ogr_log)
                    self.check_process(tip, tip_log)
                except BrokenPipeError as error:
                    self.guard()
                    raise ImportFailure('A contour preparation tool closed its input unexpectedly.') from error
                finally:
                    ogr.stdout.close()
            if not count:
                raise ImportFailure('Source sheet contains no contour features.')
            stats = mbtiles_info(output)
            saved = {'key': prepared_key(sheet), 'recipe': RECIPE, 'source': sheet, 'archiveSha256': verified['sha256'],
                     'sha256': sha256(output, self.guard), 'features': count, 'minimumElevation': minimum, 'maximumElevation': maximum,
                     **stats, 'preparedAt': utc_now()}
            durable_replace(output, path)
            saved['fingerprint'] = fingerprint(path)
            atomic_json(manifest, saved)
            return saved

    def publish(self, catalog, revision, prepared):
        published = self.root / 'published' / (revision + '.mbtiles')
        record = published.with_suffix('.json')
        total_size = sum(item['fileBytes'] for item in prepared)
        self.guard(2 * total_size)
        self.status(phase='assembling', currentSheet=None, message='Combining all completed sheets before switching the map.')
        with tempfile.TemporaryDirectory(prefix='assemble-', dir=self.root / 'work') as temporary:
            stage = Path(temporary)
            output, log = stage / 'complete.mbtiles', stage / 'tile-join.log'
            # A file list avoids command-line length limits for the statewide catalogue.
            inputs = stage / 'inputs.txt'
            inputs.write_text(''.join(str(self.prepared_paths(sheet)[0]) + '\n' for sheet in catalog['sheets']))
            with log.open('wb') as errors, self.process([self.tools['tile-join'], '-pk', '-o', str(output), '-r', str(inputs)],
                                                      stdout=subprocess.DEVNULL, stderr=errors) as child:
                self.check_process(child, log)
            stats = mbtiles_info(output)
            sheets = catalog['sheets']
            bounds = [min(s['bounds'][0] for s in sheets), min(s['bounds'][1] for s in sheets),
                      max(s['bounds'][2] for s in sheets), max(s['bounds'][3] for s in sheets)]
            result = {'format': 1, 'revision': revision, 'file': f'published/{revision}.mbtiles', 'bounds': bounds,
                      'minzoom': 10, 'maxzoom': 16, 'sheets': len(sheets), 'sourceBytes': sum(s['bytes'] for s in sheets),
                      'attribution': ATTRIBUTION, 'extractedAt': utc_now(), 'recipe': RECIPE, **stats,
                      'sha256': sha256(output, self.guard), 'sourceUrl': catalog.get('sourceUrl'), 'catalogCheckedAt': catalog.get('checkedAt'),
                      'sheetSources': [{'id': s['id'], **source_identity(s), 'archiveSha256': p['archiveSha256'], 'preparedSha256': p['sha256']}
                                       for s, p in zip(sheets, prepared)]}
            self.guard()
            durable_replace(output, published)
            result['fingerprint'] = fingerprint(published)
            atomic_json(record, result)
            # The only activation point: all inputs and the immutable publication already exist.
            atomic_json(self.root / 'current.json', result)
            return result

    def run(self):
        with self.lock():
            watcher = threading.Thread(target=self.monitor, daemon=True)
            watcher.start()
            try:
                catalog = load_catalog(self.catalog_path)
                sheets = catalog['sheets']
                revision = digest_json({'recipe': RECIPE, 'sheets': sheets})
                self.state.update(totalSheets=len(sheets), totalBytes=sum(s['bytes'] for s in sheets), revision=revision)
                # Remove only abandoned importer workspace while holding the exclusive lock.
                for child in (self.root / 'work').iterdir():
                    if child.name.startswith(('sheet-', 'assemble-')) and child.is_dir() and not child.is_symlink():
                        shutil.rmtree(child)
                publication = self.root / 'published' / (revision + '.json')
                if regular_file(publication):
                    current = read_json(publication)
                    tilefile = self.root / 'published' / (revision + '.mbtiles')
                    if (current.get('revision') == revision and current.get('file') == f'published/{revision}.mbtiles'
                            and regular_file(tilefile) and fingerprint(tilefile) == current.get('fingerprint')):
                        atomic_json(self.root / 'current.json', current)
                        self.status(phase='ready', completedSheets=len(sheets), downloadedBytes=self.state['totalBytes'], message='All selected NSW contour sheets are ready.')
                        return current
                self.tools = {name: shutil.which(name) for name in ('ogr2ogr', 'tippecanoe', 'tile-join')}
                if not all(self.tools.values()):
                    raise ImportFailure('ogr2ogr, tippecanoe and tile-join must be installed and available on PATH.')
                for sheet in sheets:
                    archive = self.archive_path(sheet)
                    partial = archive.with_name(archive.name + '.part')
                    candidate = archive if regular_file(archive) else partial
                    if regular_file(candidate):
                        self.state['downloadedBytes'] += min(candidate.stat().st_size, sheet['bytes'])
                completed = [self.reusable_sheet(sheet) for sheet in sheets]
                self.state['completedSheets'] = sum(item is not None for item in completed)
                self.status(message='Resuming retained source archives and prepared sheets.')
                prepared = []
                for sheet, saved in zip(sheets, completed):
                    self.guard()
                    self.status(currentSheet=sheet['id'], featuresPrepared=0)
                    archive, verified = self.ensure_archive(sheet)
                    if saved is not None and saved.get('archiveSha256') != verified['sha256']:
                        saved = None
                        self.state['completedSheets'] -= 1
                    if saved is None:
                        saved = self.prepare_sheet(sheet, archive, verified)
                        self.state['completedSheets'] += 1
                    prepared.append(saved)
                    self.status(message='Map sheet retained and ready for final assembly.')
                result = self.publish(catalog, revision, prepared)
                self.status(phase='ready', currentSheet=None, message='All selected NSW contour sheets are ready.')
                return result
            except (ImportFailure, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
                self.status(phase='waiting-space' if isinstance(error, WaitingSpace) else 'error', message=str(error))
                raise
            finally:
                self.monitor_done.set()
                watcher.join(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--catalog', required=True, type=Path)
    parser.add_argument('--min-free-bytes', required=True, type=int)
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args(argv)
    try:
        importer = Importer(args.data_dir, args.catalog, args.min_free_bytes, args.threads)
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_args: importer.stop.set())
        try:
            os.nice(10)
        except OSError:
            pass
        result = importer.run()
    except (ImportFailure, OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f'nsw-contours: {error}\n')
    print(json.dumps({'revision': result['revision'], 'sheets': result['sheets'], 'file': result['file']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

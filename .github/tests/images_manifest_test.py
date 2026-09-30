#!/usr/bin/env python3
"""The rules that decide which images a push rebuilds.

`.github/images.json` is what the build workflow reads: one entry per service,
its build context, its Dockerfile, and `watch` — the paths a change to which
should rebuild it.

`watch` exists because nine services take the whole of simorgh-agent as their
build context while reading only a few directories out of it. Matching on the
context would rebuild all nine every time any one of them changed. Matching on
what the Dockerfile actually COPYs rebuilds one.

Run:  python3 .github/tests/images_manifest_test.py
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
images = json.load(open(os.path.join(ROOT, '.github/images.json')))

def touched(entry, changed):
    """The workflow's own rule, copied exactly."""
    for w in (entry.get('watch') or [entry['context']]):
        w = w.rstrip('/')
        if any(f == w or f.startswith(w + '/') for f in changed):
            return True
    return False

def picked(changed):
    return sorted(i['image'] for i in images if touched(i, changed))

failures = []
def ok(name, got, want):
    if got == want:
        print('pass  ' + name)
    else:
        failures.append(name)
        print('FAIL  ' + name)
        print('   got ', got)
        print('   want', want)

ok('a change to the shared library rebuilds everything that copies it',
   picked(['simorgh-agent/shared/foo.py']),
   sorted(i['image'] for i in images
          if any(w.rstrip('/').endswith('/shared') for w in i['watch'])))

ok('a change to one service rebuilds only that service',
   picked(['simorgh-agent/techserver-mcp-service/app.py']), ['simorgh-techserver-mcp'])

ok('a change under simorgh-soft rebuilds simorgh-soft',
   picked(['simorgh-agent/simorgh-soft/simorgh-frontend/src/App.tsx']), ['simorgh-soft'])

ok('an unrelated change rebuilds nothing',
   picked(['README.md', 'simorgh-agent/compose/infra-redis.yml']), [])

# Nothing may watch the whole tree: that is the bug `watch` was added to fix.
ok('nothing watches the whole of simorgh-agent',
   [i['image'] for i in images
    if any(os.path.normpath(w) == 'simorgh-agent' for w in i['watch'])], [])

ok('every context, Dockerfile and watch path exists',
   [p for i in images for p in [i['context'], i['dockerfile'], *i['watch']]
    if not os.path.exists(os.path.join(ROOT, p))], [])

# A service nothing can select is a service that silently never rebuilds.
ok('every service is selected by a change to its own files',
   [i['image'] for i in images if i['image'] not in picked([i['watch'][0] + '/x'])
                               and i['image'] not in picked([i['watch'][0]])], [])

ok('every entry is complete',
   [i.get('image', '?') for i in images
    if not all(i.get(k) for k in ('service', 'image', 'context', 'dockerfile', 'watch'))], [])


# ── And the Dockerfiles themselves, for the two ways a build dies on a runner
# rather than on the build host. Both were found one workflow failure at a
# time, which is the slow way; this is the fast one.
import re

def lines_of(entry):
    with open(os.path.join(ROOT, entry['dockerfile']), encoding='utf-8') as fh:
        return list(enumerate(fh, 1))

# `ENV key=value` takes the rest of the line as more key=value pairs, so a
# trailing comment is parsed as one: "can't find = in #". It never showed up
# until whisper was built for the first time.
trailing = []
for i in images:
    for n, line in lines_of(i):
        m = re.match(r'^\s*(ENV|ARG)\s+(\S+=\S*)(.*)$', line.rstrip('\n'))
        if m and '#' in m.group(3):
            trailing.append('%s:%d' % (i['dockerfile'], n))
ok('no ENV or ARG carries a trailing comment on the key=value form', trailing, [])

# The Harbor proxy-cache is private and a runner has no credentials for it: a
# FROM pinned there is a 401 on the first instruction. It stays the default,
# but through an ARG the workflow can override.
pinned = []
for i in images:
    for n, line in lines_of(i):
        if re.match(r'^\s*FROM\s', line) and 'registry.simorghai.com' in line:
            pinned.append('%s:%d' % (i['dockerfile'], n))
ok('no FROM is hard-pinned to the internal registry', pinned, [])

# A FROM built from a variable needs a default, or a plain `docker build`
# resolves it to nothing.
undefaulted = []
for i in images:
    src = open(os.path.join(ROOT, i['dockerfile']), encoding='utf-8').read()
    for m in re.finditer(r'^\s*FROM\s+\S*\$\{(\w+)\}', src, re.M):
        if not re.search(r'^\s*ARG\s+%s=\S' % m.group(1), src, re.M):
            undefaulted.append('%s: %s' % (i['dockerfile'], m.group(1)))
ok('every variable used in a FROM has an ARG default', undefaulted, [])


# A RUN that reaches for an interpreter its base image does not carry. TEI is a
# Rust binary and its image has no python3 at all; the model download had been
# written straight into it and failed with "python3: not found" the first time
# anyone built it. Continuations are folded first — that fault lives on the
# line after the RUN, which is how a first version of this check missed it.
interpreter = []
for i in images:
    src = open(os.path.join(ROOT, i['dockerfile']), encoding='utf-8').read()
    joined = re.sub(r'\\\s*\n', ' ', src)
    froms = re.findall(r'^\s*FROM\s+(\S+)', src, re.M)
    uses = re.search(r'^\s*RUN\b[^\n]*\b(python3?|pip3?)\b', joined, re.M)
    carries = any(re.search(r'python|pytorch|docling', f, re.I) for f in froms)
    installs = re.search(r'apt-get install[^\n]*python', joined)
    if uses and not carries and not installs:
        interpreter.append('%s (base %s)' % (i['image'], froms[-1] if froms else '?'))
ok('no RUN calls python on a base image that has none', interpreter, [])


# ── The split itself: the default stack must not be able to build ───────────
#
# When a service names both an image and a build context, a failed pull falls
# through to building it. That is not theoretical — an expired registry login
# on the deploy host did not fail, it started a twenty-minute build of the
# image it could not download. The build instructions therefore live only in
# docker-compose.build.yml, and this is what keeps them there.
import glob

stray = []
for f in sorted(glob.glob(os.path.join(ROOT, 'simorgh-agent/compose/*.yml'))):
    for n, line in enumerate(open(f, encoding='utf-8'), 1):
        if re.match(r'^\s+build:', line):
            stray.append('%s:%d' % (os.path.relpath(f, ROOT), n))
ok('no service file carries a build section', stray, [])

override = os.path.join(ROOT, 'simorgh-agent/docker-compose.build.yml')
text = open(override, encoding='utf-8').read()
ok('the build override still carries them',
   len(re.findall(r'^\s+build:', text, re.M)) > 0, True)

# They moved up one directory when they moved file, so a path that still
# climbs out of simorgh-agent/ is one that was not adjusted.
climbing = re.findall(r'^\s+(?:build|context):\s*(\.\.\S*)\s*$', text, re.M)
ok('no build path still points outside simorgh-agent', climbing, [])

print()
print('ALL PASS' if not failures else '%d FAILED' % len(failures))
sys.exit(1 if failures else 0)

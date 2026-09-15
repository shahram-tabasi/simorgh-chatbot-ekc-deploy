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

print()
print('ALL PASS' if not failures else '%d FAILED' % len(failures))
sys.exit(1 if failures else 0)

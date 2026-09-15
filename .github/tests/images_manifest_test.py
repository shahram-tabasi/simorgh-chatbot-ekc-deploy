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

print()
print('ALL PASS' if not failures else '%d FAILED' % len(failures))
sys.exit(1 if failures else 0)

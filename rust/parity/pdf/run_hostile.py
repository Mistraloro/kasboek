"""Runs a reader on every file of a directory and reports panics, aborts, hangs and memory. usage: run_hostile.py DIR -- CMD...
(the file is appended to CMD). The address space of each run is capped at 8 GiB (NOLIMIT=1 lifts it, node needs that); a run over 90 s counts as a hang.
Answers: `{"error": code}` / `{"pages": ...}` (kb-pdf-cli read) or the last line of the reader process (`{"ok": ...}`, after progress lines).
For the reader process of the app (reads stdin): run_hostile.py DIR -- sh -c 'exec target/release/kb-pdf-cli --pdf-reader < "$0"'"""
import json, os, resource, subprocess, sys, time

d = sys.argv[1]
cmd = sys.argv[3:]
rows = []
def limit():
    if os.environ.get('NOLIMIT'):
        return
    resource.setrlimit(resource.RLIMIT_AS, (8 << 30, 8 << 30))
for n in sorted(os.listdir(d)):
    if not n.endswith('.pdf'):
        continue
    t = time.time()
    rss = None
    try:
        p = subprocess.run(cmd + [os.path.join(d, n)], capture_output=True, timeout=90, preexec_fn=limit)
        wall = time.time() - t
        status = 'exit%d' % p.returncode if p.returncode >= 0 else 'signal%d' % -p.returncode
        # only \n ends a line (splitlines also cuts at \x0b, \x1c, \u2028 ... which JSON text may hold)
        lines = [x for x in p.stdout.decode('latin1').split('\n') if x]
        out = lines[-1][:200] if lines else ''
        code = None
        if out.startswith('{"error"'):
            code = json.loads(lines[-1])['error']
        elif out.startswith('{"pages"'):
            code = 'ok'
        elif out.startswith('{"ok":true'):
            code = 'ok'
        elif out.startswith('{"ok":false'):
            code = json.loads(lines[-1]).get('code') or 'error'
        err = p.stderr.decode('latin1')
        panic = 'panicked' in err
        for line in err.splitlines():
            if line.startswith('{"ms"'):
                rss = json.loads(line).get('rssMb')
    except subprocess.TimeoutExpired:
        wall, status, code, panic, rss = 90, 'HANG', None, False, None
    rows.append(dict(name=n, status=status, code=code, wall=round(wall, 2), rss=rss, panic=panic))
bad = [r for r in rows if r['status'] != 'exit0' or r['panic'] or r['code'] is None]
slow = [r for r in rows if r['wall'] > 5]
print(json.dumps(dict(total=len(rows), by_code={c: sum(1 for r in rows if r['code'] == c) for c in sorted({str(r['code']) for r in rows})}), indent=None))
print('not clean (crash / abort / hang / panic message / no answer):', len(bad))
for r in bad:
    print('  ', r)
print('slower than 5 s:', len(slow))
for r in slow:
    print('  ', r)
named = [r for r in rows if not r['name'].startswith('fuzz_')]
print('%-34s %-8s %-22s %7s %8s' % ('file', 'status', 'answer', 'wall s', 'peak MB'))
for r in named:
    print('%-34s %-8s %-22s %7.2f %8s' % (r['name'], r['status'], r['code'], r['wall'], r['rss']))
json.dump(rows, open(os.path.join(d, 'results.json'), 'w'))

"""Invented statement PDFs whose fonts have no ToUnicode map, to measure what the Rust reader recovers from the font program
(rust/crates/kb-pdf/src/recover.rs). Every file shows the same invented table; `truth.json` in OUT says which file is the
reference (the same table with a ToUnicode map). Usage: gen_cid_matrix.py OUTDIR (uses LiberationSans from node_modules)."""
import json, os, struct, sys, zlib

OUT = sys.argv[1]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
LIB = os.path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')
PFB = os.path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb') if os.path.exists(os.path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb')) else None
os.makedirs(OUT, exist_ok=True)

LINES = [
    ('Statement of account', 40, 780), ('Account BE68 5390 0754 7034', 40, 766),
    ('Date', 40, 742), ('Description', 110, 742), ('Debit', 300, 742), ('Credit', 380, 742), ('Balance', 460, 742),
    ('01/11/2026', 40, 728), ('Bakkerij Zon 1', 110, 728), ('12.50', 300, 728), ('987.50', 460, 728),
    ('05/11/2026', 40, 714), ('Salaris november', 110, 714), ('2000.00', 380, 714), ('2987.50', 460, 714),
    ('07/11/2026', 40, 700), ('Café Zürich €', 110, 700), ('30.00', 300, 700), ('2957.50', 460, 700),
]

def stream(d, data, flate=True):
    if flate: data = zlib.compress(data); d += ' /Filter /FlateDecode'
    return f'<< {d} /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream'

def build(objs):
    out = bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'); offs = {}
    for i, b in sorted(objs.items()):
        offs[i] = len(out); out += f'{i} 0 obj\n'.encode() + (b.encode() if isinstance(b, str) else b) + b'\nendobj\n'
    n = max(objs) + 1; xo = len(out)
    out += f'xref\n0 {n}\n0000000000 65535 f \n'.encode()
    for i in range(1, n): out += (f'{offs[i]:010d} 00000 n \n' if i in offs else '0000000000 00000 f \n').encode()
    out += f'trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xo}\n%%EOF\n'.encode()
    return bytes(out)

def tables(d):
    n = struct.unpack('>H', d[4:6])[0]
    return [list(struct.unpack('>4sIII', d[12 + 16 * i:28 + 16 * i])) for i in range(n)]

def tag_table(d):
    return {r[0].decode(): d[r[2]:r[2] + r[3]] for r in tables(d)}

def assemble(tabs):
    """A font file from {tag: bytes}, tables sorted and 4-byte aligned (checksums are not needed by the readers)."""
    tags = sorted(tabs)
    n = len(tags)
    entry = 1
    while entry * 2 <= n: entry *= 2
    out = struct.pack('>IHHHH', 0x00010000, n, entry * 16, entry.bit_length() - 1, n * 16 - entry * 16)
    off = 12 + 16 * n
    body = b''
    for t in tags:
        data = tabs[t]
        out += struct.pack('>4sIII', t.encode(), 0, off + len(body), len(data))
        body += data + b'\0' * (-len(data) % 4)
    return out + body

def subset(d, text, keep_tables=('head', 'hhea', 'maxp', 'hmtx', 'cmap', 'post')):
    """The font cut down to the glyphs of `text` (and the parts of composites), glyph numbers unchanged: glyf and loca keep only
    those glyphs. Tables not in keep_tables are dropped (leave out 'cmap' or 'post' to make the text unrecoverable from them)."""
    t = tag_table(d)
    head = bytearray(t['head'])
    long_loca = struct.unpack('>h', head[50:52])[0]
    num = struct.unpack('>H', t['maxp'][4:6])[0]
    loca = list(struct.unpack(f'>{num + 1}I', t['loca'])) if long_loca else [2 * x for x in struct.unpack(f'>{num + 1}H', t['loca'])]
    g_of, _ = cmap_fn(d)
    want = {0} | {g_of(ord(c)) for c in text}
    todo = list(want)
    while todo:
        g = todo.pop()
        data = t['glyf'][loca[g]:loca[g + 1]]
        if len(data) >= 10 and struct.unpack('>h', data[:2])[0] < 0:   # composite glyph: add its components
            p = 10
            while True:
                flags, comp = struct.unpack('>HH', data[p:p + 4])
                if comp not in want: want.add(comp); todo.append(comp)
                p += 4 + (4 if flags & 1 else 2)
                p += 8 if flags & 0x80 else 4 if flags & 0x40 else 2 if flags & 8 else 0
                if not flags & 0x20: break
    glyf = b''; new_loca = []
    for g in range(num):
        new_loca.append(len(glyf))
        if g in want:
            data = t['glyf'][loca[g]:loca[g + 1]]; glyf += data + b'\0' * (-len(data) % 4)
    new_loca.append(len(glyf))
    head[50:52] = struct.pack('>h', 1)
    tabs = {k: v for k, v in t.items() if k in keep_tables}
    tabs.update({'head': bytes(head), 'glyf': glyf, 'loca': struct.pack(f'>{num + 1}I', *new_loca)})
    return assemble(tabs)

def cmap_fn(d):
    t = {r[0].decode(): (r[2], r[3]) for r in tables(d)}
    off = t['cmap'][0]
    nt = struct.unpack('>H', d[off + 2:off + 4])[0]
    sub = None
    for i in range(nt):
        pid, eid, so = struct.unpack('>HHI', d[off + 4 + 8 * i:off + 12 + 8 * i])
        if (pid, eid) == (3, 1): sub = off + so
    seg = struct.unpack('>H', d[sub + 6:sub + 8])[0] // 2
    ends = struct.unpack(f'>{seg}H', d[sub + 14:sub + 14 + 2 * seg]); p = sub + 16 + 2 * seg
    starts = struct.unpack(f'>{seg}H', d[p:p + 2 * seg]); p += 2 * seg
    deltas = struct.unpack(f'>{seg}h', d[p:p + 2 * seg]); p += 2 * seg
    ro_pos = p; ros = struct.unpack(f'>{seg}H', d[p:p + 2 * seg])
    def glyph(cp):
        for k in range(seg):
            if starts[k] <= cp <= ends[k]:
                if ros[k] == 0: return (cp + deltas[k]) & 0xffff
                a = ro_pos + 2 * k + ros[k] + 2 * (cp - starts[k]); g = struct.unpack('>H', d[a:a + 2])[0]
                return (g + deltas[k]) & 0xffff if g else 0
        return 0
    hh = t['hhea'][0]; nh = struct.unpack('>H', d[hh + 34:hh + 36])[0]; upm = struct.unpack('>H', d[t['head'][0] + 18:t['head'][0] + 20])[0]
    def width(g):
        g = min(g, nh - 1)
        return round(struct.unpack('>H', d[t['hmtx'][0] + 4 * g:t['hmtx'][0] + 4 * g + 2])[0] * 1000 / upm)
    return glyph, width

ALL_TEXT = ''.join(t for t, _, _ in LINES)
FULL = open(LIB, 'rb').read()
glyph, width = cmap_fn(FULL)
# Small fonts: only the glyphs of the table are kept, so a file is about 20 KB and can be committed as a test fixture.
FONT = subset(FULL, ALL_TEXT)

def cid_file(name, font=FONT, to_unicode=False, cid_shift=None):
    """Type0 / CIDFontType2 / Identity-H. cid_shift: CIDs are gid + shift and a CIDToGIDMap stream maps them back."""
    used = {}
    def enc(s):
        h = ''
        for ch in s:
            g = glyph(ord(ch)); cid = g + (cid_shift or 0); used[cid] = (g, ch); h += f'{cid:04X}'
        return h
    ops = ['BT', '/F1 9 Tf'] + [f'1 0 0 1 {x} {y} Tm <{enc(t)}> Tj' for t, x, y in LINES] + ['ET']
    objs = {1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [10 0 R] /Count 1 >>'}
    objs[3] = '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+LiberationSans /Encoding /Identity-H /DescendantFonts [4 0 R]' + (' /ToUnicode 7 0 R' if to_unicode else '') + ' >>'
    ws = ' '.join(f'{c} [{width(g)}]' for c, (g, _) in sorted(used.items()))
    gidmap = ' /CIDToGIDMap 8 0 R' if cid_shift else ' /CIDToGIDMap /Identity'
    objs[4] = f'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+LiberationSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R{gidmap} /DW 1000 /W [{ws}] >>'
    objs[5] = '<< /Type /FontDescriptor /FontName /AAAAAA+LiberationSans /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 700 /StemV 80 /FontFile2 6 0 R >>'
    objs[6] = stream(f'/Length1 {len(font)}', font)
    if to_unicode:
        bf = ''.join(f'<{c:04X}> <{ord(ch):04X}>\n' for c, (_, ch) in sorted(used.items()))
        objs[7] = stream('', f'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange {len(used)} beginbfchar\n{bf}endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'.encode())
    if cid_shift:
        top = max(used) + 1
        data = b''.join(struct.pack('>H', used[c][0] if c in used else 0) for c in range(top))
        objs[8] = stream('', data)
    objs[10] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R >>'
    objs[11] = stream('', '\n'.join(ops).encode())
    open(os.path.join(OUT, name + '.pdf'), 'wb').write(build(objs))

def simple_truetype(name, to_unicode=False):
    """A simple symbolic TrueType font (no Encoding): the codes are the characters, the glyphs come from the font's own cmap."""
    ops = ['BT', '/F1 9 Tf'] + [f'1 0 0 1 {x} {y} Tm ({t.encode("cp1252").decode("latin1").replace(chr(92), chr(92) * 2).replace("(", chr(92) + "(").replace(")", chr(92) + ")")}) Tj' for t, x, y in LINES] + ['ET']
    objs = {1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [10 0 R] /Count 1 >>'}
    ws = ' '.join(str(width(glyph(c))) for c in range(32, 256))
    objs[3] = f'<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+LiberationSans /FirstChar 32 /LastChar 255 /Widths [{ws}] /FontDescriptor 5 0 R' + (' /ToUnicode 7 0 R' if to_unicode else '') + ' >>'
    objs[5] = '<< /Type /FontDescriptor /FontName /AAAAAA+LiberationSans /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 700 /StemV 80 /FontFile2 6 0 R >>'
    objs[6] = stream(f'/Length1 {len(FONT)}', FONT)
    objs[10] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R >>'
    objs[11] = stream('', '\n'.join(ops).encode('latin1'))
    open(os.path.join(OUT, name + '.pdf'), 'wb').write(build(objs))

cases = {}
cid_file('ref_with_tounicode', to_unicode=True)
cid_file('cid_identity_full_font')
cid_file('cid_cidtogid_stream', cid_shift=300)
cid_file('cid_no_cmap_names_only', font=subset(FULL, ALL_TEXT, ('head', 'hhea', 'maxp', 'hmtx', 'post')))
cid_file('cid_no_cmap_no_names', font=subset(FULL, ALL_TEXT, ('head', 'hhea', 'maxp', 'hmtx')))
simple_truetype('truetype_simple_symbolic')
json.dump({'reference': 'ref_with_tounicode', 'recoverable': ['cid_identity_full_font', 'cid_cidtogid_stream', 'cid_no_cmap_names_only'], 'unrecoverable': ['cid_no_cmap_no_names'],
           # A symbolic simple TrueType font with neither Encoding nor ToUnicode: hayro reads the codes above 127 with its default encoding
           # (the accented line comes out wrong), the ASCII text is right.
           'partial': ['truetype_simple_symbolic']}, open(os.path.join(OUT, 'truth.json'), 'w'))
print('ok')

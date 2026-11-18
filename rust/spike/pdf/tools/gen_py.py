"""Invented statement PDFs made with reportlab and by hand (CID fonts, object streams, operators). Usage: genpy.py OUTDIR"""
import sys, os, struct, zlib
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

OUT = sys.argv[1]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
LIB = os.path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')
# Optional second TrueType font (any .ttf) for a different glyph order; skipped when unset.
CRIM = os.environ.get('KB_EXTRA_TTF', '')
pdfmetrics.registerFont(TTFont('Lib', LIB))
if CRIM and os.path.exists(CRIM): pdfmetrics.registerFont(TTFont('Crim', CRIM))
pdfmetrics.registerFont(pdfmetrics.Font('HelvMac', 'Helvetica', 'MacRomanEncoding'))
pdfmetrics.registerFont(pdfmetrics.Font('TimesMac', 'Times-Roman', 'MacRomanEncoding'))

DESC = ['Albert Heijn Brussel', 'Café Zürich', 'Crédit Agricole', 'Müller & Zoon', 'Boulangerie Léa', 'Señor Tapas', 'Électricité €', 'Pâtisserie Œuf', 'Ærø Færgen', 'Salaris november (ref 12/34)']
def rows(n, start=0):
    bal = 100000
    out = []
    for i in range(start, start + n):
        amt = 1000 + (i * 7919) % 90000
        credit = i % 5 == 4
        bal += amt if credit else -amt
        out.append((f'{1 + i % 28:02d}/11/2026', DESC[i % len(DESC)], '' if credit else f'{amt/100:,.2f}', f'{amt/100:,.2f}' if credit else '', f'{bal/100:,.2f}'))
    return out
XS = [40, 110, 300, 380, 460]
HEAD = ('Date', 'Description', 'Debit', 'Credit', 'Balance')

def table(c, font, size, pages=2, per=30, size_page=A4, rot=None, tweak=None, enc=None):
    w, h = size_page
    for p in range(pages):
        if rot: c.setPageRotation(rot)
        y = h - 60
        c.setFont(font, size)
        c.drawString(40, y, 'Statement of account'); y -= 14
        c.drawString(40, y, 'Account BE68 5390 0754 7034'); y -= 14
        c.drawString(40, y, f'Page {p+1} of {pages}'); y -= 20
        for i, hd in enumerate(HEAD): c.drawString(XS[i], y, hd)
        y -= 14
        for r in rows(per, p * per):
            for i, cell in enumerate(r):
                if not cell: continue
                if i >= 2: c.drawRightString(XS[i] + 60, y, cell)
                else: c.drawString(XS[i], y, cell)
            y -= 14
        c.showPage()

def mk(name, **kw):
    path = os.path.join(OUT, name)
    c = canvas.Canvas(path, pagesize=kw.pop('pagesize', A4), pageCompression=kw.pop('comp', 1), invariant=1)
    return c, path

for name, font, size in [('rl_helvetica', 'Helvetica', 9), ('rl_times', 'Times-Roman', 10), ('rl_courier', 'Courier', 8), ('rl_helv_macroman', 'HelvMac', 9), ('rl_times_macroman', 'TimesMac', 10), ('rl_ttf_liberation', 'Lib', 9), ('rl_ttf_crimson', 'Crim', 11), ('rl_helv_bold', 'Helvetica-Bold', 9)]:
    if font == 'Crim' and not (CRIM and os.path.exists(CRIM)): continue
    c, _ = mk(name + '.pdf'); table(c, font, size); c.save()
c, _ = mk('rl_uncompressed.pdf', comp=0); table(c, 'Helvetica', 9); c.save()
c, _ = mk('rl_landscape.pdf', pagesize=landscape(A4)); table(c, 'Helvetica', 9, size_page=landscape(A4)); c.save()
c, _ = mk('rl_rotate90.pdf', pagesize=landscape(A4)); table(c, 'Lib', 9, size_page=landscape(A4), rot=90); c.save()
c, _ = mk('rl_rotate270.pdf'); table(c, 'Helvetica', 9, rot=270); c.save()
c, _ = mk('rl_rotate180.pdf'); table(c, 'Helvetica', 9, rot=180); c.save()
c, _ = mk('rl_letter.pdf', pagesize=(612, 792)); table(c, 'Times-Roman', 10, size_page=(612, 792)); c.save()
c, _ = mk('rl_long_71p.pdf'); table(c, 'Helvetica', 8, pages=71, per=52); c.save()

# Character spacing, word spacing, horizontal scaling, text rise, leading with T*, ' and "
c, _ = mk('rl_spacing.pdf')
for p in range(2):
    y = 780
    for i, r in enumerate(rows(25, p * 25)):
        t = c.beginText(40, y)
        t.setFont('Helvetica', 9)
        if i % 3 == 0: t.setCharSpace(0.6)
        if i % 3 == 1: t.setWordSpace(4)
        if i % 4 == 2: t.setHorizScale(85)
        t.textOut(r[0]); t.setXPos(70); t.textOut(r[1]); t.setXPos(190); t.textOut(r[4])
        c.drawText(t); y -= 14
    t = c.beginText(40, 300); t.setFont('Helvetica', 9); t.setLeading(12)
    for r in rows(8, 50): t.textLine(' | '.join(r))   # T* with leading
    c.drawText(t)
    c.showPage()
c.save()

# Raw PDFs --------------------------------------------------------------------------------
def esc(s): return s.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')

def build(objs, objstm=False, root=1):
    """objs: dict id -> bytes (dict or stream body already serialised). Writes classic xref or object streams."""
    objs = {i: (b.encode() if isinstance(b, str) else b) for i, b in objs.items()}
    out = bytearray(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')
    offs = {}
    maxid = max(objs) + 1
    if objstm:
        packable = [i for i, b in objs.items() if b'\nstream\n' not in b]
        body = b''; idx = b''
        for i in packable:
            idx += f'{i} {len(body)} '.encode(); body += objs[i] + b'\n'
        data = zlib.compress(idx + body)
        sid = maxid; maxid += 1
        for i, b in objs.items():
            if i in packable: continue
            offs[i] = len(out); out += f'{i} 0 obj\n'.encode() + b + b'\nendobj\n'
        offs[sid] = len(out)
        out += f'{sid} 0 obj\n<< /Type /ObjStm /N {len(packable)} /First {len(idx)} /Length {len(data)} /Filter /FlateDecode >>\nstream\n'.encode() + data + b'\nendstream\nendobj\n'
        xid = maxid; maxid += 1
        xoff = len(out)
        rowsx = b'\x00\x00\x00\x00\x00\xff'
        for i in range(1, xid):
            if i in packable: rowsx += b'\x02' + struct.pack('>I', sid) + bytes([packable.index(i)])
            elif i in offs: rowsx += b'\x01' + struct.pack('>I', offs[i]) + b'\x00'
            else: rowsx += b'\x00\x00\x00\x00\x00\x00'
        rowsx += b'\x01' + struct.pack('>I', xoff) + b'\x00'
        # rows are 6 bytes: type(1) f2(4) f3(1); the row for object 0 needs the same width
        xd = zlib.compress(rowsx)
        out += f'{xid} 0 obj\n<< /Type /XRef /Size {xid+1} /W [1 4 1] /Root {root} 0 R /Length {len(xd)} /Filter /FlateDecode >>\nstream\n'.encode() + xd + b'\nendstream\nendobj\n'
        out += f'startxref\n{xoff}\n%%EOF\n'.encode()
    else:
        for i, b in sorted(objs.items()):
            offs[i] = len(out); out += f'{i} 0 obj\n'.encode() + b + b'\nendobj\n'
        xo = len(out)
        out += f'xref\n0 {maxid}\n0000000000 65535 f \n'.encode()
        for i in range(1, maxid): out += (f'{offs[i]:010d} 00000 n \n' if i in offs else '0000000000 00000 f \n').encode()
        out += f'trailer\n<< /Size {maxid} /Root {root} 0 R >>\nstartxref\n{xo}\n%%EOF\n'.encode()
    return bytes(out)

def stream(d, data, flate=True):
    if flate: data = zlib.compress(data); d += ' /Filter /FlateDecode'
    return f'<< {d} /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream'

def ttf_tables(path):
    d = open(path, 'rb').read()
    n = struct.unpack('>H', d[4:6])[0]
    t = {}
    for i in range(n):
        tag, _, off, ln = struct.unpack('>4sIII', d[12 + 16 * i:28 + 16 * i]); t[tag.decode()] = (off, ln)
    return d, t
def ttf_cmap(d, t):
    off = t['cmap'][0]
    nt = struct.unpack('>H', d[off + 2:off + 4])[0]
    sub = None
    for i in range(nt):
        pid, eid, so = struct.unpack('>HHI', d[off + 4 + 8 * i:off + 12 + 8 * i])
        if (pid, eid) in ((3, 1), (0, 3), (0, 4)) and struct.unpack('>H', d[off + so:off + so + 2])[0] == 4: sub = off + so
    seg = struct.unpack('>H', d[sub + 6:sub + 8])[0] // 2
    ends = struct.unpack(f'>{seg}H', d[sub + 14:sub + 14 + 2 * seg])
    p = sub + 16 + 2 * seg
    starts = struct.unpack(f'>{seg}H', d[p:p + 2 * seg]); p += 2 * seg
    deltas = struct.unpack(f'>{seg}h', d[p:p + 2 * seg]); p += 2 * seg
    ro_pos = p
    ros = struct.unpack(f'>{seg}H', d[p:p + 2 * seg])
    def glyph(cp):
        for k in range(seg):
            if starts[k] <= cp <= ends[k]:
                if ros[k] == 0: return (cp + deltas[k]) & 0xffff
                a = ro_pos + 2 * k + ros[k] + 2 * (cp - starts[k])
                g = struct.unpack('>H', d[a:a + 2])[0]
                return (g + deltas[k]) & 0xffff if g else 0
        return 0
    return glyph
def ttf_widths(d, t):
    nh = struct.unpack('>H', d[t['hhea'][0] + 34:t['hhea'][0] + 36])[0]
    upm = struct.unpack('>H', d[t['head'][0] + 18:t['head'][0] + 20])[0]
    def w(g):
        g = min(g, nh - 1)
        return round(struct.unpack('>H', d[t['hmtx'][0] + 4 * g:t['hmtx'][0] + 4 * g + 2])[0] * 1000 / upm)
    return w

def cid_pdf(name, objstm=False, tj_kern=False, mediabox='[0 0 595 842]', rotate=0, pages=2, per=30, with_tounicode=True):
    d, t = ttf_tables(LIB); glyph = ttf_cmap(d, t); wid = ttf_widths(d, t)
    used = {}
    def enc(s):
        h = ''
        for ch in s:
            g = glyph(ord(ch)); used[g] = ch; h += f'{g:04X}'
        return h
    contents = []
    for p in range(pages):
        ops = ['BT', '/F1 9 Tf']
        y = 780
        hdr = ['Statement of account', 'Account BE68 5390 0754 7034']
        for h in hdr:
            ops.append(f'1 0 0 1 40 {y} Tm <{enc(h)}> Tj'); y -= 14
        y -= 10
        for i, hd in enumerate(HEAD): ops.append(f'1 0 0 1 {XS[i]} {y} Tm <{enc(hd)}> Tj')
        y -= 14
        for r in rows(per, p * per):
            for i, cell in enumerate(r):
                if not cell: continue
                if tj_kern and i == 1 and len(cell) > 4:
                    a, b = cell[:3], cell[3:]
                    ops.append(f'1 0 0 1 {XS[i]} {y} Tm [<{enc(a)}> -35 <{enc(b)}>] TJ')
                else: ops.append(f'1 0 0 1 {XS[i]} {y} Tm <{enc(cell)}> Tj')
            y -= 14
        ops.append('ET')
        contents.append('\n'.join(ops).encode())
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>'}
    kids = [10 + 2 * i for i in range(pages)]
    objs[2] = f'<< /Type /Pages /Kids [{" ".join(f"{k} 0 R" for k in kids)}] /Count {pages} >>'.encode()
    objs[3] = b'<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+LiberationSans /Encoding /Identity-H /DescendantFonts [4 0 R]' + (b' /ToUnicode 7 0 R' if with_tounicode else b'') + b' >>'
    ws = ' '.join(f'{g} [{wid(g)}]' for g in sorted(used))
    objs[4] = f'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+LiberationSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /CIDToGIDMap /Identity /DW 1000 /W [{ws}] >>'.encode()
    objs[5] = b'<< /Type /FontDescriptor /FontName /AAAAAA+LiberationSans /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 700 /StemV 80 /FontFile2 6 0 R >>'
    objs[6] = stream(f'/Length1 {len(d)}', d)
    bf = ''.join(f'<{g:04X}> <{ord(ch):04X}>\n' for g, ch in sorted(used.items()))
    cm = f'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange {len(used)} beginbfchar\n{bf}endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
    objs[7] = stream('', cm.encode())
    for i in range(pages):
        objs[10 + 2 * i] = f'<< /Type /Page /Parent 2 0 R /MediaBox {mediabox}' + (f' /Rotate {rotate}' if rotate else '') + f' /Resources << /Font << /F1 3 0 R >> >> /Contents {11 + 2 * i} 0 R >>'.encode().decode() if False else (f'<< /Type /Page /Parent 2 0 R /MediaBox {mediabox}' + (f' /Rotate {rotate}' if rotate else '') + f' /Resources << /Font << /F1 3 0 R >> >> /Contents {11 + 2 * i} 0 R >>').encode()
        objs[11 + 2 * i] = stream('', contents[i])
    open(os.path.join(OUT, name), 'wb').write(build(objs, objstm=objstm))

cid_pdf('raw_cid_identityH.pdf')
cid_pdf('raw_cid_identityH_objstm.pdf', objstm=True)
cid_pdf('raw_cid_tj_kern.pdf', tj_kern=True)
cid_pdf('raw_cid_rotate90.pdf', mediabox='[0 0 595 842]', rotate=90)
cid_pdf('raw_cid_no_tounicode.pdf', with_tounicode=False)

def simple_pdf(name, body_fn, fonts, mediabox='[0 0 595 842]', objstm=False, extra_objs=None, res_extra='', pages=1):
    objs = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 2: b'<< /Type /Pages /Kids [10 0 R] /Count 1 >>'}
    fr = ' '.join(f'/{n} {i} 0 R' for n, i, _ in fonts)
    for n, i, d in fonts: objs[i] = d.encode()
    objs[10] = f'<< /Type /Page /Parent 2 0 R /MediaBox {mediabox} /Resources << /Font << {fr} >> {res_extra} >> /Contents 11 0 R >>'.encode()
    objs[11] = stream('', body_fn().encode('latin1'))
    if extra_objs: objs.update(extra_objs)
    open(os.path.join(OUT, name), 'wb').write(build(objs, objstm=objstm))

# TJ arrays with kerning, ' and " operators, T*, TL, Tz, Ts, cm scaling, nested q/Q
def ops_body():
    L = ['BT /F1 10 Tf 12 TL 40 780 Td (Operators statement) Tj T*']
    L.append('(Line with quote operator) \' (Another quote line) \' 3 1 (Word and char spacing via double quote) " ET')
    L.append('BT /F1 10 Tf 1 0 0 1 40 700 Tm [(Kern) -250 (ed) 120 (text) -1000 (gap) 50 (ped)] TJ ET')
    L.append('q 2 0 0 2 0 0 cm BT /F1 5 Tf 20 300 Td (Scaled by CTM) Tj ET Q')
    L.append('q 0.5 0 0 0.5 100 100 cm 1 0 0 1 0 0 cm BT /F2 20 Tf 0 0 Td (Half size Times) Tj ET Q')
    L.append('BT /F1 10 Tf 80 Tz 1 0 0 1 40 650 Tm (Horizontal scale 80 percent) Tj 100 Tz 5 Ts ( raised) Tj 0 Ts ET')
    L.append('BT /F3 10 Tf 40 620 Td (Courier fixed width 0123456789) Tj ET')
    L.append('BT /F1 10 Tf 40 600 Td (Caf\\351 Z\\374rich \\200 12,50 \\(paren\\) back\\\\slash octal \\101\\102) Tj ET')
    L.append('BT /F4 10 Tf 40 580 Td (Caf\\216 Z\\237rich \\333 Mac) Tj ET')
    L.append('BT /F1 10 Tf 0 1 -1 0 300 500 Tm (Upward text) Tj ET')
    L.append('BT /F1 10 Tf -1 0 0 -1 300 400 Tm (Upside down) Tj ET')
    return '\n'.join(L)
fonts = [('F1', 3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
         ('F2', 4, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'),
         ('F3', 5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'),
         ('F4', 6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>')]
simple_pdf('raw_operators.pdf', ops_body, fonts)
simple_pdf('raw_operators_objstm.pdf', ops_body, fonts, objstm=True)

# Differences encoding + custom widths on a TrueType-style simple font without embedding
def diff_body():
    return 'BT /F1 10 Tf 40 700 Td (Diff \\001\\002 text) Tj ET\nBT /F2 10 Tf 40 680 Td (Widths 012 ABC) Tj ET'
fonts2 = [('F1', 3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /eacute /Euro] >> >>'),
          ('F2', 4, '<< /Type /Font /Subtype /TrueType /BaseFont /ArialMT /FirstChar 32 /LastChar 126 /Widths [' + ' '.join(['600'] * 95) + '] /Encoding /WinAnsiEncoding >>')]
simple_pdf('raw_differences.pdf', diff_body, fonts2)

# Form XObject with its own matrix and font resources, inherited page resources and MediaBox, CropBox offset
def form_body(): return 'q 1 0 0 1 50 100 cm /Fm1 Do Q\nBT /F1 10 Tf 40 700 Td (Page text) Tj ET'
form = stream('/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Matrix [1 0 0 1 0 0] /Resources << /Font << /F1 3 0 R >> >>', b'BT /F1 12 Tf 10 200 Td (Inside the form xobject) Tj ET', flate=False)
simple_pdf('raw_form_xobject.pdf', form_body, fonts[:1], extra_objs={12: form}, res_extra='/XObject << /Fm1 12 0 R >>')
simple_pdf('raw_cropbox_offset.pdf', lambda: 'BT /F1 10 Tf 140 700 Td (Cropped page text) Tj 0 -14 Td (Second line of the crop) Tj ET', fonts[:1], mediabox='[100 100 500 800] /CropBox [120 150 480 750]')
print('ok')

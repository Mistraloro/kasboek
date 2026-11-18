"""Invented hostile and broken PDFs for the robustness run. Usage: gen_hostile.py CORPUS_DIR OUT_DIR (needs rl_helvetica.pdf from gen_py.py)."""
import os, random, sys, zlib

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

def w(name, data):
    open(os.path.join(OUT, name + '.pdf'), 'wb').write(data if isinstance(data, bytes) else data.encode('latin1'))

def stream(d, data):
    return f'<< {d} /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream'

def pdf(objs, trailer='', root=1):
    out = bytearray(b'%PDF-1.4\n')
    offs = {}
    for i, b in sorted(objs.items()):
        offs[i] = len(out)
        out += f'{i} 0 obj\n'.encode() + (b if isinstance(b, bytes) else b.encode('latin1')) + b'\nendobj\n'
    n = max(objs) + 1
    xo = len(out)
    out += f'xref\n0 {n}\n0000000000 65535 f \n'.encode()
    for i in range(1, n):
        out += (f'{offs[i]:010d} 00000 n \n' if i in offs else '0000000000 00000 f \n').encode()
    out += f'trailer\n<< /Size {n} /Root {root} 0 R {trailer} >>\nstartxref\n{xo}\n%%EOF\n'.encode()
    return bytes(out)

FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
TEXT = b'BT /F1 10 Tf 40 700 Td (Hello hostile world, this is a long enough text for a page) Tj ET\n'

def one_page(content, extra_objs=None, page_extra='', res='', fonts=''):
    objs = {1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: FONT,
            4: f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R {fonts} >> {res} >> /Contents 5 0 R {page_extra} >>',
            5: stream('', content)}
    if extra_objs: objs.update(extra_objs)
    return pdf(objs)

src = open(os.path.join(SRC, 'rl_helvetica.pdf'), 'rb').read()
w('empty', b'')
w('header_only', b'%PDF-1.4\n')
w('not_a_pdf', b'hello, this is not a pdf at all\n' * 100)
w('truncated_half', src[:len(src) // 2])
w('truncated_90', src[:len(src) * 9 // 10])
w('truncated_no_xref', src[:src.rfind(b'xref')] if b'xref' in src else src[:-200])
rnd = random.Random(7)
w('garbage_body', b'%PDF-1.4\n' + bytes(rnd.randrange(256) for _ in range(200_000)))
w('stream_length_wrong', src.replace(b'/Length ', b'/Length 9'))

# Circular and recursive structures
w('pages_self_kid', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [2 0 R 4 0 R] /Count 2 >>', 3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', TEXT)}))
w('pages_parent_loop', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [6 0 R] /Count 1 /Parent 6 0 R >>', 6: '<< /Type /Pages /Kids [4 0 R] /Count 1 /Parent 2 0 R >>', 3: FONT,
    4: '<< /Type /Page /Parent 6 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', TEXT)}))
w('contents_self_array', one_page(TEXT, {5: '[5 0 R 5 0 R]'}))
w('font_self_ref', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [3 0 R] /ToUnicode 3 0 R >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', TEXT)}))
form = lambda body, res='': stream('/Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /A 6 0 R /B 7 0 R >> >>', body)
w('form_self_recursion', one_page(b'/A Do\n' + TEXT, {6: form(b'/A Do BT /F1 10 Tf 40 600 Td (Loop A text text text text text) Tj ET'), 7: form(b'/A Do')}, res='/XObject << /A 6 0 R >>'))
w('form_mutual_recursion', one_page(b'/A Do\n' + TEXT, {6: form(b'/B Do BT /F1 10 Tf 40 600 Td (Loop A text text text text text) Tj ET'), 7: form(b'/A Do')}, res='/XObject << /A 6 0 R /B 7 0 R >>'))
# a form that draws two forms that draw two forms ... 30 levels: 2^30 draws unless the reader caps the work
objs = {}
for i in range(30):
    nxt = 20 + i + 1
    objs[20 + i] = stream('/Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> /XObject << /N %d 0 R >> >>' % nxt, b'/N Do /N Do BT /F1 8 Tf 40 600 Td (x) Tj ET')
objs[50] = stream('/Type /XObject /Subtype /Form /BBox [0 0 600 800]', b'')
objs[50] = stream('/Type /XObject /Subtype /Form /BBox [0 0 600 800]', b'')
w('form_exponential', one_page(b'/N Do\n' + TEXT, objs, res='/XObject << /N 20 0 R >>'))
t3 = '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 8 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [500] /Resources << /Font << /T 6 0 R >> >> >>'
w('type3_recursion', one_page(b'BT /T 12 Tf 40 600 Td (aaaa) Tj ET\n' + TEXT, {6: t3, 8: stream('', b'500 0 d0 BT /T 1000 Tf (aa) Tj ET')}, fonts='/T 6 0 R'))
w('xref_prev_loop', src.replace(b'trailer\n<<', b'trailer\n<< /Prev 9 ', 1) if b'trailer' in src else src)

# Depth
w('deep_q', one_page(b'q\n' * 2_000_000 + TEXT))
w('deep_array_in_content', one_page(b'[' * 1_000_000 + b' ] TJ\n' + TEXT))
w('deep_dict_in_content', one_page(b'/X ' + b'<<' * 500_000 + b'>>' * 500_000 + b' BDC\n' + TEXT))
w('deep_array_object', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Junk ' + '[' * 300_000 + ']' * 300_000 + ' >>', 5: stream('', TEXT)}))
w('deep_dict_object', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Junk ' + '<</A ' * 200_000 + '1' + '>>' * 200_000 + ' >>', 5: stream('', TEXT)}))
chain = {1: '<< /Type /Catalog /Pages 10 0 R >>', 3: FONT, 5: stream('', TEXT)}
N = 20000
for i in range(N):
    chain[10 + i] = f'<< /Type /Pages /Kids [{11 + i} 0 R] /Count 1 /Parent {9 + i} 0 R >>'
chain[10 + N] = '<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>' % (9 + N)
w('page_tree_depth_20000', pdf(chain))

# Size
def pages(n):
    objs = {1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [' + ' '.join(f'{10 + i} 0 R' for i in range(n)) + f'] /Count {n} >>', 3: FONT, 5: stream('', TEXT)}
    for i in range(n):
        objs[10 + i] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'
    return pdf(objs)
w('pages_150', pages(150))
w('pages_151', pages(151))
w('pages_5000', pages(5000))
w('items_150k', one_page(b'BT /F1 8 Tf 12 TL 10 800 Td\n' + b''.join(b'(Line %d is a line of text) Tj 0 -0.01 Td\n' % i for i in range(150_000)) + b'ET\n'))
w('items_90k_ok', one_page(b'BT /F1 8 Tf 12 TL 10 800 Td\n' + b''.join(b'(Line %d is a line of text) Tj 0 -9 Td 400 0 Td -400 0 Td\n' % i for i in range(90_000)) + b'ET\n'))
w('chars_2M_one_string', one_page(b'BT /F1 8 Tf 10 800 Td (' + b'a' * 2_000_000 + b') Tj ET\n'))
w('chars_1M_in_many', one_page(b'BT /F1 8 Tf 10 800 Td\n' + b''.join(b'(' + b'b' * 1000 + b') Tj 0 -9 Td\n' for _ in range(1500)) + b'ET\n'))
c = zlib.compressobj(9)
body = b''.join(c.compress(b'\0' * 1_048_576) for _ in range(2048)) + c.flush()   # 2 GiB of zeros
w('bomb_2GiB_content', one_page(b'', {5: stream('/Filter /FlateDecode', body)}))
c = zlib.compressobj(9)
body = c.compress(TEXT + b' ' * 1_048_576) + b''.join(c.compress(b' ' * 1_048_576) for _ in range(300)) + c.flush()
w('bomb_300MiB_spaces_with_text', one_page(b'', {5: stream('/Filter /FlateDecode', body)}))
# Numbers and geometry
w('mediabox_huge', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1e30 1e30] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', TEXT)}))
w('mediabox_negative_zero', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 3: FONT,
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 0 0] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', TEXT)}))
w('matrix_extreme', one_page(b'BT /F1 1e300 Tf 1e300 0 0 1e300 1e300 1e300 Tm (Huge) Tj ET\nBT /F1 0 Tf 40 700 Td (Zero size text) Tj ET\nBT /F1 10 Tf 0 0 0 0 40 700 Tm (Singular matrix) Tj ET\n' + TEXT))
w('operand_overflow', one_page(b'1 2 3 ' * 1_000_000 + b'Tj\n' + TEXT))
# ToUnicode and font tables
bf = ''.join('<0000> <FFFF> <0041>\n' for _ in range(100_000))
cm = f'/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 100000 beginbfrange\n{bf}endbfrange endcmap end end'
w('tounicode_huge_ranges', pdf({1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    3: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
    7: stream('', cm.encode()),
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 5: stream('', b'BT /F1 10 Tf 40 700 Td <00410042004300440045> Tj ET')}))
w('no_text_page', one_page(b'0 0 100 100 re f\n'))
# Byte-flip fuzz of the valid corpus files
fuzz = random.Random(20260101)
names = [n for n in sorted(os.listdir(SRC)) if n.endswith('.pdf') and os.path.getsize(os.path.join(SRC, n)) < 60_000 and not n.startswith('rl_long')]
for k in range(int(os.environ.get('FUZZ', '300'))):
    n = fuzz.choice(names)
    data = bytearray(open(os.path.join(SRC, n), 'rb').read())
    for _ in range(fuzz.choice([1, 3, 10, 50])):
        i = fuzz.randrange(len(data))
        data[i] = fuzz.randrange(256) if fuzz.random() < 0.7 else data[i] ^ (1 << fuzz.randrange(8))
    if fuzz.random() < 0.15:
        a = fuzz.randrange(len(data))
        del data[a:a + fuzz.randrange(1, 200)]
    w(f'fuzz_{k:03d}', bytes(data))
print('ok')

"""Builds the standalone index.html from src/. Standard library only; output is deterministic."""
from base64 import b64encode
from pathlib import Path

root = Path(__file__).parent
src = root / 'src'


def read(name):
    return (src / name).read_text(encoding='utf-8').strip('\n')


template = read('template.html')
font = b64encode((root / 'assets' / 'recursive-latin-mono.woff2').read_bytes()).decode('ascii')
font_face = (
    '/* Recursive (subset: Latin, axes MONO + wght) © 2019 The Recursive Project Authors, SIL Open Font License 1.1.'
    ' Full licence: assets/LICENSE_RECURSIVE_OFL.txt */\n'
    '@font-face{font-family:"Recursive VEIL";font-style:normal;font-weight:300 1000;font-display:swap;'
    'src:url(data:font/woff2;base64,' + font + ') format("woff2")}'
)
css = read('styles.css').replace('/*@font*/', font_face, 1)
parts = {
    '/*@theme-boot*/': read('theme-boot.js'),
    '/*@css*/': css,
    '/*@ui*/': read('ui.js'),
    '/*@core*/': read('core.js'),
    '/*@qr*/': read('qr_vendor.js'),
    '/*@p2p*/': read('p2p.js'),
}
html = template
for marker, content in parts.items():
    if template.count(marker) != 1:
        raise SystemExit('Marcador ausente ou duplicado no template: ' + marker)
    if '</script' in content.lower() or '</style' in content.lower():
        raise SystemExit('Conteúdo embutido não pode fechar a própria tag: ' + marker)
    html = html.replace(marker, content, 1)

# The single file must stay self-contained: no remote scripts, styles, fonts or images.
for forbidden in ('<script src', '<link ', 'src="http', 'href="http', 'url(http', '@import'):
    if forbidden in html:
        raise SystemExit('Referência externa inesperada no HTML final: ' + forbidden)

(root / 'index.html').write_text(html + '\n', encoding='utf-8')
print('Created index.html ·', len(html.encode('utf-8')), 'bytes')

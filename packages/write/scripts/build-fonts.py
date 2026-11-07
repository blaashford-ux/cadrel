#!/usr/bin/env python3
"""
Builds packages/write/assets/fonts/<slug>/ for the OFL families added in M3, from a checkout of
github.com/google/fonts (the `ofl/` folder). Run: python3 scripts/build-fonts.py /path/to/google/fonts

Rules (SIL OFL 1.1):
- Every family folder gets the upstream OFL.txt unchanged (it carries the copyright notice).
- A family whose OFL.txt names a Reserved Font Name is NEVER modified: its variable fonts are copied byte
  for byte as Variable.ttf / VariableItalic.ttf. (Cutting a static instance is a modification, and a
  modified version may not keep the Reserved Font Name.)
- Other variable families are cut into static Regular / Italic / Bold / BoldItalic instances (wght 400 and
  700, other axes pinned). The font's own name table is left as upstream wrote it.
- Static upstream files are copied unchanged.
Needs: pip install fonttools
"""
import re, shutil, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# slug -> (upstream folder, kind, extra pinned axes)
FAMILIES = {
    'cormorant-garamond': ('cormorantgaramond', 'variable', {}),
    'alegreya': ('alegreya', 'variable', {}),
    'fraunces': ('fraunces', 'variable', {'opsz': 72}),
    'literata': ('literata', 'variable', {}),
    'source-serif-4': ('sourceserif4', 'variable', {}),
    'gelasio': ('gelasio', 'variable', {}),
    'bodoni-moda': ('bodonimoda', 'variable', {'opsz': 28}),
    'spectral': ('spectral', 'static', {}),
    'playfair-display': ('playfairdisplay', 'variable', {}),
    'merriweather': ('merriweather', 'variable', {}),
    'lora': ('lora', 'variable', {}),
    'marcellus': ('marcellus', 'static1', {}),
}

def has_rfn(ofl: str) -> bool:
    # The copyright line names it: 'with Reserved Font Name "X"' (the licence body always mentions the term).
    return bool(re.search(r'with Reserved Font Names?\s+"', ofl.split('\n', 1)[0]))

def find(src: Path, pattern: str) -> Path:
    hits = sorted(src.glob(pattern))
    if not hits:
        raise SystemExit(f'missing {src}/{pattern}')
    return hits[0]

def instance(path: Path, wght: int, pins: dict, out: Path):
    f = TTFont(path)
    loc = {}
    for ax in f['fvar'].axes:
        loc[ax.axisTag] = wght if ax.axisTag == 'wght' else pins.get(ax.axisTag, ax.defaultValue)
        if ax.axisTag == 'wght':
            loc['wght'] = min(max(wght, ax.minValue), ax.maxValue)
    instantiateVariableFont(f, loc, inplace=True)
    f.save(out)

def main(root: str):
    ofl = Path(root) / 'ofl'
    out_root = Path(__file__).resolve().parent.parent / 'assets' / 'fonts'
    for slug, (folder, kind, pins) in FAMILIES.items():
        src, dst = ofl / folder, out_root / slug
        dst.mkdir(parents=True, exist_ok=True)
        text = (src / 'OFL.txt').read_text(encoding='utf-8')
        shutil.copyfile(src / 'OFL.txt', dst / 'OFL.txt')
        if kind == 'static1':
            shutil.copyfile(find(src, '*-Regular.ttf'), dst / 'Regular.ttf')
        elif kind == 'static':
            for name, up in [('Regular', 'Regular'), ('Italic', 'Italic'), ('Bold', 'Bold'), ('BoldItalic', 'BoldItalic')]:
                shutil.copyfile(find(src, f'*-{up}.ttf'), dst / f'{name}.ttf')
        elif has_rfn(text):
            shutil.copyfile([p for p in src.glob('*.ttf') if 'Italic' not in p.name][0], dst / 'Variable.ttf')
            shutil.copyfile([p for p in src.glob('*.ttf') if 'Italic' in p.name][0], dst / 'VariableItalic.ttf')
        else:
            up = [p for p in src.glob('*.ttf') if 'Italic' not in p.name][0]
            it = [p for p in src.glob('*.ttf') if 'Italic' in p.name][0]
            instance(up, 400, pins, dst / 'Regular.ttf')
            instance(up, 700, pins, dst / 'Bold.ttf')
            instance(it, 400, pins, dst / 'Italic.ttf')
            instance(it, 700, pins, dst / 'BoldItalic.ttf')
        print(slug, 'RFN' if has_rfn(text) else '-', kind)

if __name__ == '__main__':
    main(sys.argv[1])

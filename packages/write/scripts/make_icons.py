#!/usr/bin/env python3
"""
Regenerates the app icons from assets/branding/app-icon-source.jpg (needs: pip install pillow).

  build/icon.ico   Windows executable + installer icon (16–256 px)
  build/icon.png   512 px, used by electron-builder for other platforms
  assets/icon.png  256 px, used for the window/taskbar icon at runtime

The source is a flat square; it is given rounded transparent corners so it reads as an app tile.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "assets/branding/app-icon-source.jpg").convert("RGBA")
size = 1024
src = src.resize((size, size), Image.LANCZOS)

# rounded-corner mask, drawn 4x and downsampled for smooth edges
radius = int(size * 0.2)
mask = Image.new("L", (size * 4, size * 4), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=radius * 4, fill=255)
mask = mask.resize((size, size), Image.LANCZOS)
master = Image.new("RGBA", (size, size), (0, 0, 0, 0))
master.paste(src, (0, 0), mask)

(root / "build").mkdir(exist_ok=True)
master.resize((512, 512), Image.LANCZOS).save(root / "build/icon.png")
master.resize((256, 256), Image.LANCZOS).save(root / "assets/icon.png")
sizes = [16, 24, 32, 48, 64, 128, 256]
master.save(root / "build/icon.ico", sizes=[(s, s) for s in sizes])
print("wrote build/icon.ico, build/icon.png, assets/icon.png")

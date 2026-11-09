"""ytplayer.ico を作る（濃い角丸の四角に、オレンジの再生マークとリストの線）。

    python make_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
BG = (24, 26, 32, 255)
ACCENT = (255, 138, 40, 255)
LINE = (220, 224, 232, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((8, 8, SIZE - 8, SIZE - 8), radius=52, fill=BG)
# 再生マーク（左上）
d.polygon([(52, 48), (52, 152), (140, 100)], fill=ACCENT)
# 再生リストの線（右と下）
for y in (60, 100, 140):
    d.rounded_rectangle((160, y - 9, 208, y + 9), radius=9, fill=LINE)
for y in (180, 210):
    d.rounded_rectangle((52, y - 9, 208, y + 9), radius=9, fill=LINE)

out = Path(__file__).with_name("ytplayer.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.save(out.with_suffix(".png"))
print(out)

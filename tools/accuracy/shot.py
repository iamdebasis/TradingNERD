"""Reading a TradingView screenshot's pixels with the standard library: macOS's `sips` turns the
PNG into an uncompressed BMP, which is read here as it is."""
import os
import struct
import subprocess
import tempfile


class Shot:
    """A screenshot's pixels, (red, green, blue) by (x, y) from the top left."""

    def __init__(self, png_path):
        with tempfile.TemporaryDirectory() as tmp:
            bmp = os.path.join(tmp, 'shot.bmp')
            subprocess.run(['sips', '-s', 'format', 'bmp', png_path, '--out', bmp], check=True, capture_output=True)
            self.b = open(bmp, 'rb').read()
        self.off = struct.unpack_from('<I', self.b, 10)[0]
        self.w, h = struct.unpack_from('<ii', self.b, 18)
        self.h = abs(h)
        self.top_down = h < 0
        self.bpp = struct.unpack_from('<H', self.b, 28)[0] // 8
        self.row = (self.w * self.bpp + 3) & ~3

    def px(self, x, y):
        yy = y if self.top_down else self.h - 1 - y
        i = self.off + yy * self.row + x * self.bpp
        return self.b[i + 2], self.b[i + 1], self.b[i]


def is_red(c):
    """TradingView's falling candle, #F23645, as the screenshot has it."""
    r, g, b = c
    return r > 150 and g < 110 and b < 120


def is_green(c):
    """TradingView's rising candle, #089981."""
    r, g, b = c
    return g > 110 and r < 90 and b > 80

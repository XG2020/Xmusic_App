"""Sync Windows icons from the Android launcher's original artwork.

Run from any directory: python desktop/scripts/sync-icons.py
Requires Pillow, available in the bundled Codex Python runtime.

Android's mobile/scripts/gen_app_icon.ps1 uses the same root logo.jpg and an
18% rounded rectangle. Render from that original artwork instead of enlarging
the 192 px Android output, preserving detail in Windows' 256 px icon frame.
"""

from pathlib import Path
import json
import struct

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "logo.jpg"
OUTPUT = ROOT / "desktop" / "resources"
PNG_SIZE = 512
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
CORNER_RADIUS = 0.18  # Same as mobile/scripts/gen_app_icon.ps1.


def validate() -> dict:
    png_path = OUTPUT / "icon.png"
    ico_path = OUTPUT / "icon.ico"
    with Image.open(png_path) as png:
        assert png.size == (PNG_SIZE, PNG_SIZE), "Unexpected PNG size"
        assert png.mode == "RGBA", "PNG must retain transparent corners"
        assert png.getpixel((0, 0))[3] == 0, "PNG corner must be transparent"
        assert png.getpixel((PNG_SIZE // 2, PNG_SIZE // 2))[3] == 255
    with ico_path.open("rb") as stream:
        reserved, kind, count = struct.unpack("<HHH", stream.read(6))
        assert (reserved, kind, count) == (0, 1, len(ICO_SIZES)), "Invalid ICO header"
    with Image.open(ico_path) as ico:
        expected = {(size, size) for size in ICO_SIZES}
        assert ico.ico.sizes() == expected, "Missing ICO frames"
        for size in ICO_SIZES:
            frame = ico.ico.getimage((size, size))
            assert frame.size == (size, size) and frame.mode == "RGBA"
            # At 16 px the rounded edge covers a small fraction of the corner
            # pixel. Preserve that antialias coverage instead of hard clipping it.
            assert frame.getpixel((0, 0))[3] < 32, f"Opaque corner at {size} px"
    return {"source": str(SOURCE), "png": [PNG_SIZE, PNG_SIZE], "ico_frames": list(ICO_SIZES), "transparent_corners": True}


def main() -> None:
    with Image.open(SOURCE) as source:
        source = ImageOps.exif_transpose(source)
        if source.width != source.height:
            raise ValueError("The mobile launcher source must be square; review mobile icon generation before syncing.")
        artwork = source.convert("RGBA").resize((PNG_SIZE, PNG_SIZE), Image.Resampling.LANCZOS)
    # Supersampling keeps the shared rounded silhouette smooth at every scale.
    mask_size = PNG_SIZE * 4
    mask = Image.new("L", (mask_size, mask_size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, mask_size - 1, mask_size - 1), radius=mask_size * CORNER_RADIUS, fill=255)
    artwork.putalpha(mask.resize((PNG_SIZE, PNG_SIZE), Image.Resampling.LANCZOS))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    artwork.save(OUTPUT / "icon.png", optimize=True)
    artwork.save(OUTPUT / "icon.ico", sizes=[(size, size) for size in ICO_SIZES])
    print(json.dumps(validate(), ensure_ascii=False))


if __name__ == "__main__":
    main()

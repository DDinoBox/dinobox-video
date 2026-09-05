import sys
from pathlib import Path

from PIL import Image, ImageOps


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: normalize_reference_image.py <input> <output.png>")

    source = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        normalized = ImageOps.exif_transpose(image).convert("RGB")
        normalized.thumbnail((2200, 2200), Image.Resampling.LANCZOS)
        normalized.save(output, "PNG", optimize=True)


if __name__ == "__main__":
    main()

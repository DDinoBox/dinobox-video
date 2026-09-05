import argparse
import json
from pathlib import Path

from PIL import Image, ImageOps

WIDTH = 941
HEIGHT = 1672


def parse_normalized_bounds(value, label):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise argparse.ArgumentTypeError(f"{label} must be JSON [x,y,width,height]") from exc
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise argparse.ArgumentTypeError(f"{label} must be [x,y,width,height]")
    try:
        x, y, width, height = (float(component) for component in value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"{label} values must be numbers") from exc
    if not all(0 <= component <= 1 for component in (x, y, width, height)) or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
        raise argparse.ArgumentTypeError(f"{label} must be normalized within [0,1]")
    return x, y, width, height


def parse_panel_sequence(value):
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 2:
        raise argparse.ArgumentTypeError("panelSequence must contain exactly two official panel crops")
    panels = []
    for index, panel in enumerate(value, start=1):
        if not isinstance(panel, dict):
            raise argparse.ArgumentTypeError("panelSequence entries must be objects")
        crop = parse_normalized_bounds(panel.get("panelCrop"), f"panelSequence[{index}].panelCrop")
        if not crop:
            raise argparse.ArgumentTypeError("panelSequence entries require panelCrop")
        panels.append({
            "crop": crop,
            "declares_source": any(str(panel.get(key) or "").strip() for key in ("referenceId", "sourceUrl", "mediaUrl")),
        })
    return panels


def parse_args():
    parser = argparse.ArgumentParser(description="Render an official still as a deterministic 9:16 crop or declared two-panel explanatory diagram.")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--crop-json", help="JSON object containing panelCrop/focusBounds/panelSequence or a normalized bounds array")
    parser.add_argument("--panel-crop", help="normalized JSON [x,y,width,height]")
    parser.add_argument("--focus-bounds", help="normalized JSON [x,y,width,height]")
    parser.add_argument("--panel-sequence-inputs", nargs=2, metavar=("FIRST_PANEL", "SECOND_PANEL"), help="exactly two verified official source image paths, in panelSequence order")
    args = parser.parse_args()
    metadata = {}
    if args.crop_json:
        try:
            metadata = json.loads(args.crop_json)
        except json.JSONDecodeError as exc:
            parser.error(f"--crop-json must be valid JSON: {exc.msg}")
    if isinstance(metadata, list):
        metadata = {"panelCrop": metadata}
    if not isinstance(metadata, dict):
        parser.error("--crop-json must be an object or normalized bounds array")
    try:
        panel_crop = parse_normalized_bounds(args.panel_crop if args.panel_crop else metadata.get("panelCrop"), "panelCrop")
        focus_bounds = parse_normalized_bounds(args.focus_bounds if args.focus_bounds else metadata.get("focusBounds"), "focusBounds")
        panel_sequence = parse_panel_sequence(metadata.get("panelSequence"))
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    if args.panel_sequence_inputs and not panel_sequence:
        parser.error("--panel-sequence-inputs requires panelSequence")
    if panel_sequence and any(panel["declares_source"] for panel in panel_sequence) and not args.panel_sequence_inputs:
        parser.error("panelSequence with referenceId/sourceUrl/mediaUrl requires --panel-sequence-inputs")
    return args.input, args.output, panel_crop or focus_bounds, panel_sequence, args.panel_sequence_inputs


def crop_to_bounds(image, bounds):
    if not bounds:
        return image
    x, y, width, height = bounds
    left = round(x * image.width)
    top = round(y * image.height)
    right = round((x + width) * image.width)
    bottom = round((y + height) * image.height)
    if right <= left or bottom <= top:
        raise ValueError("normalized crop resolves to an empty source region")
    return image.crop((left, top, right, bottom))


def render_two_panel_sequence(images, panel_sequence):
    if len(images) != 2 or len(panel_sequence) != 2:
        raise ValueError("two-panel sequences require exactly two source images and two crops")
    gap = round(HEIGHT * 0.025)
    panel_height = (HEIGHT - gap) // 2
    rendered = Image.new("RGB", (WIDTH, HEIGHT), "black")
    for index, (image, panel_contract) in enumerate(zip(images, panel_sequence)):
        panel = crop_to_bounds(image, panel_contract["crop"])
        fitted = ImageOps.contain(panel, (WIDTH, panel_height), method=Image.Resampling.LANCZOS)
        x = (WIDTH - fitted.width) // 2
        y = index * (panel_height + gap) + (panel_height - fitted.height) // 2
        rendered.paste(fitted, (x, y))
    return rendered


def load_official_image(source):
    with Image.open(source) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def main() -> None:
    source_arg, output_arg, bounds, panel_sequence, panel_sequence_inputs = parse_args()
    source = Path(source_arg).resolve()
    output = Path(output_arg).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    if panel_sequence:
        source_paths = [Path(value).resolve() for value in (panel_sequence_inputs or [source, source])]
        rendered = render_two_panel_sequence([load_official_image(path) for path in source_paths], panel_sequence)
    else:
        official = load_official_image(source)
        rendered = ImageOps.fit(
            crop_to_bounds(official, bounds),
            (WIDTH, HEIGHT),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    rendered.save(output, "PNG", optimize=True)


if __name__ == "__main__":
    main()

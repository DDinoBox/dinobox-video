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
            "focus": parse_normalized_bounds(panel.get("focusBounds"), f"panelSequence[{index}].focusBounds"),
            "required": parse_normalized_bounds(panel.get("requiredBounds"), f"panelSequence[{index}].requiredBounds"),
            "declares_source": any(str(panel.get(key) or "").strip() for key in ("referenceId", "sourceUrl", "mediaUrl")),
        })
    return panels


def parse_args():
    parser = argparse.ArgumentParser(description="Render an official still as a deterministic 9:16 crop or declared two-panel explanatory diagram.")
    parser.add_argument("input")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--preflight", action="store_true", help="Decode and check shared crop geometry only; never write an output")
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
        required_bounds = parse_normalized_bounds(metadata.get("requiredBounds"), "requiredBounds")
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))
    if args.panel_sequence_inputs and not panel_sequence:
        parser.error("--panel-sequence-inputs requires panelSequence")
    if panel_sequence and any(panel["declares_source"] for panel in panel_sequence) and not args.panel_sequence_inputs:
        parser.error("panelSequence with referenceId/sourceUrl/mediaUrl requires --panel-sequence-inputs")
    if panel_sequence and (panel_crop or focus_bounds or required_bounds):
        parser.error("HOLD official_crop_ambiguous: sequence bounds must be declared per panel")
    if not args.preflight and not args.output:
        parser.error("output is required unless --preflight is used")
    return args.input, args.output, panel_crop or focus_bounds, focus_bounds, required_bounds, panel_sequence, args.panel_sequence_inputs, args.preflight


def bounds_box(image, bounds):
    x, y, width, height = bounds or (0, 0, 1, 1)
    box = (round(x * image.width), round(y * image.height),
           round((x + width) * image.width), round((y + height) * image.height))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("HOLD official_crop_empty: normalized crop resolves to an empty source region")
    return box


def required_box(image, selected, bounds):
    if bounds:
        x, y, width, height = bounds
        box = (x * image.width, y * image.height, (x + width) * image.width, (y + height) * image.height)
    else:
        box = selected
    if box[0] < selected[0] or box[1] < selected[1] or box[2] > selected[2] or box[3] > selected[3]:
        raise ValueError("HOLD official_crop_outside_panel: declared bounds extend outside selected panel")
    return box


def cover_box(image, bounds, focus_bounds, required_bounds):
    # focusBounds remains the legacy fallback crop, not a semantic required-elements map.
    selected = bounds_box(image, bounds)
    required = required_box(image, selected, required_bounds)
    if focus_bounds:
        focus = required_box(image, selected, focus_bounds)
        required = (min(required[0], focus[0]), min(required[1], focus[1]),
                    max(required[2], focus[2]), max(required[3], focus[3]))
    left, top, right, bottom = selected
    width, height = right - left, bottom - top
    crop_width = min(width, height * WIDTH / HEIGHT)
    crop_height = min(height, width * HEIGHT / WIDTH)
    # Subpixel aspect mismatch is raster rounding, not permission to drop an edge pixel.
    if width - crop_width < 1 and height - crop_height < 1:
        return selected
    if required[2] - required[0] > crop_width or required[3] - required[1] > crop_height:
        reason = "official_crop_required_bounds_infeasible" if required_bounds else "official_crop_required_bounds_missing"
        raise ValueError(f"HOLD {reason}: full-bleed cover would discard declared source region; provide verified requiredBounds or a different source")
    x_min, x_max = max(left, required[2] - crop_width), min(right - crop_width, required[0])
    y_min, y_max = max(top, required[3] - crop_height), min(bottom - crop_height, required[1])
    x = min(max(left + (width - crop_width) / 2, x_min), x_max)
    y = min(max(top + (height - crop_height) / 2, y_min), y_max)
    return x, y, x + crop_width, y + crop_height


def render_cover(image, bounds, focus_bounds, required_bounds):
    box = cover_box(image, bounds, focus_bounds, required_bounds)
    if box == bounds_box(image, bounds):
        return image.crop(box).resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    return image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS, box=box)


def panel_box(image, panel_contract):
    selected = bounds_box(image, panel_contract["crop"])
    required_box(image, selected, panel_contract.get("required"))
    required_box(image, selected, panel_contract.get("focus"))
    return selected


def render_two_panel_sequence(images, panel_sequence):
    if len(images) != 2 or len(panel_sequence) != 2:
        raise ValueError("two-panel sequences require exactly two source images and two crops")
    gap = round(HEIGHT * 0.025)
    panel_height = (HEIGHT - gap) // 2
    rendered = Image.new("RGB", (WIDTH, HEIGHT), "black")
    for index, (image, panel_contract) in enumerate(zip(images, panel_sequence)):
        selected = panel_box(image, panel_contract)
        panel = image.crop(selected)
        fitted = ImageOps.contain(panel, (WIDTH, panel_height), method=Image.Resampling.LANCZOS)
        x = (WIDTH - fitted.width) // 2
        y = index * (panel_height + gap) + (panel_height - fitted.height) // 2
        rendered.paste(fitted, (x, y))
    return rendered


def load_official_image(source):
    with Image.open(source) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def main() -> None:
    source_arg, output_arg, bounds, focus_bounds, required_bounds, panel_sequence, panel_sequence_inputs, preflight = parse_args()
    source = Path(source_arg).resolve()
    source_paths = [Path(value).resolve() for value in (panel_sequence_inputs or ([source, source] if panel_sequence else [source]))]
    images = [load_official_image(path) for path in source_paths]
    if preflight:
        # Only these known geometry failures authorize candidate replacement. Decode,
        # argument, dependency and unexpected code failures retain their nonzero exit.
        try:
            boxes = ([panel_box(image, panel) for image, panel in zip(images, panel_sequence)]
                     if panel_sequence else [cover_box(images[0], bounds, focus_bounds, required_bounds)])
        except ValueError as exc:
            code = str(exc).split(":", 1)[0].removeprefix("HOLD ")
            if code not in {"official_crop_empty", "official_crop_outside_panel",
                            "official_crop_required_bounds_infeasible", "official_crop_required_bounds_missing"}:
                raise
            print(json.dumps({"version": 1, "geometryOnly": True, "passed": False, "code": code}))
            return
        print(json.dumps({"version": 1, "geometryOnly": True, "passed": True, "boxes": boxes,
                          "sourceSizes": [image.size for image in images]}))
        return
    output = Path(output_arg).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rendered = (render_two_panel_sequence(images, panel_sequence) if panel_sequence
                else render_cover(images[0], bounds, focus_bounds, required_bounds))
    rendered.save(output, "PNG", optimize=True)


if __name__ == "__main__":
    main()

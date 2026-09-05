import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


PALETTE = {
    "cyan": (50, 220, 235, 245),
    "amber": (255, 190, 55, 245),
    "red": (255, 82, 82, 245),
    "white": (248, 251, 252, 255),
    "panel": (8, 14, 20, 196),
    "faint": (248, 251, 252, 150),
}
SAFE_CAPTION_TOP_RATIO = 0.74
FRAME_MARGIN_RATIO = 0.035


def font(path, size):
    font_path = Path(path)
    if not font_path.is_file():
        raise FileNotFoundError(f"INFO 글꼴을 찾을 수 없습니다: {font_path}")
    return ImageFont.truetype(str(font_path), size=size)


def fit_text(draw, text, font_path, max_width, start_size, min_size=24):
    size = start_size
    while size >= min_size:
        candidate = font(font_path, size)
        box = draw.textbbox((0, 0), text, font=candidate)
        if box[2] - box[0] <= max_width:
            return candidate, size, box
        size -= 2
    candidate = font(font_path, min_size)
    return candidate, min_size, draw.textbbox((0, 0), text, font=candidate)


def relative_luminance(rgb):
    values = []
    for channel in rgb[:3]:
        value = channel / 255.0
        values.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]


def contrast_ratio(left, right):
    first = relative_luminance(left)
    second = relative_luminance(right)
    lighter = max(first, second)
    darker = min(first, second)
    return (lighter + 0.05) / (darker + 0.05)


def box_overlap(left, right, padding=0):
    return not (
        left[2] + padding <= right[0]
        or right[2] + padding <= left[0]
        or left[3] + padding <= right[1]
        or right[3] + padding <= left[1]
    )


def clamp_box_origin(x, y, panel_width, panel_height, width, height):
    margin = int(width * FRAME_MARGIN_RATIO)
    safe_top = int(height * SAFE_CAPTION_TOP_RATIO)
    return (
        min(max(margin, x), max(margin, width - margin - panel_width)),
        min(max(margin, y), max(margin, safe_top - panel_height)),
    )


def place_label_box(candidate, panel_size, occupied, width, height):
    panel_width, panel_height = panel_size
    x, y = clamp_box_origin(candidate[0], candidate[1], panel_width, panel_height, width, height)
    step = max(18, int(height * 0.025))
    attempts = [(x, y)]
    for offset in range(1, 9):
        attempts.extend([(x, y + step * offset), (x, y - step * offset)])
    for attempt_x, attempt_y in attempts:
        attempt_x, attempt_y = clamp_box_origin(
            attempt_x, attempt_y, panel_width, panel_height, width, height
        )
        box = (attempt_x, attempt_y, attempt_x + panel_width, attempt_y + panel_height)
        if not any(box_overlap(box, previous, padding=max(8, int(width * 0.012))) for previous in occupied):
            return box
    return (x, y, x + panel_width, y + panel_height)


def arrow_head(draw, start, end, color, width):
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    size = width * 3.2
    left = (end[0] - size * math.cos(angle - 0.55), end[1] - size * math.sin(angle - 0.55))
    right = (end[0] - size * math.cos(angle + 0.55), end[1] - size * math.sin(angle + 0.55))
    draw.polygon((end, left, right), fill=color)


def arrow(draw, start, end, color, width):
    draw.line((start, end), fill=color, width=width)
    arrow_head(draw, start, end, color, width)
    return {
        "kind": "arrow",
        "start": [round(start[0]), round(start[1])],
        "end": [round(end[0]), round(end[1])],
        "lengthPx": round(math.dist(start, end), 2),
    }


def dashed_line(draw, start, end, color, width, dash=16, gap=11):
    distance = max(1.0, math.dist(start, end))
    dx = (end[0] - start[0]) / distance
    dy = (end[1] - start[1]) / distance
    cursor = 0.0
    while cursor < distance:
        segment_end = min(distance, cursor + dash)
        draw.line(
            (
                (start[0] + dx * cursor, start[1] + dy * cursor),
                (start[0] + dx * segment_end, start[1] + dy * segment_end),
            ),
            fill=color,
            width=width,
        )
        cursor += dash + gap


def polyline_arrow(draw, points, color, width, dashed=False):
    for start, end in zip(points, points[1:]):
        if dashed:
            dashed_line(draw, start, end, color, width)
        else:
            draw.line((start, end), fill=color, width=width)
    if len(points) >= 2:
        arrow_head(draw, points[-2], points[-1], color, width)
    return {
        "kind": "path",
        "points": [[round(point[0]), round(point[1])] for point in points],
        "lengthPx": round(sum(math.dist(start, end) for start, end in zip(points, points[1:])), 2),
    }


def bezier_arrow(draw, start, control, end, color, width, dashed=False):
    points = []
    for index in range(25):
        t = index / 24
        inverse = 1 - t
        points.append((
            inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
            inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1],
        ))
    return polyline_arrow(draw, points, color, width, dashed=dashed)


def anchor_dot(draw, point, color, radius):
    draw.ellipse(
        (point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius),
        fill=color,
        outline=PALETTE["white"],
        width=max(1, radius // 3),
    )


def render_label(draw, candidate, value, label_font_path, value_font_path, color, width, height, occupied):
    is_value = any(char.isdigit() for char in value)
    selected_path = value_font_path if is_value else label_font_path
    selected, font_size, text_box = fit_text(
        draw, value, selected_path, int(width * 0.34), max(24, int(width * 0.033)), min_size=20
    )
    padding_x = int(width * 0.014)
    padding_y = int(width * 0.008)
    panel_width = text_box[2] - text_box[0] + padding_x * 2
    panel_height = text_box[3] - text_box[1] + padding_y * 2
    panel = place_label_box(candidate, (panel_width, panel_height), occupied, width, height)
    occupied.append(panel)
    draw.rounded_rectangle(
        panel,
        radius=max(5, int(width * 0.007)),
        fill=PALETTE["panel"],
        outline=color,
        width=max(2, int(width * 0.002)),
    )
    draw.text(
        (panel[0] + padding_x, panel[1] + padding_y - text_box[1]),
        value,
        font=selected,
        fill=PALETTE["white"],
    )
    return {
        "text": value,
        "box": list(panel),
        "fontPath": str(Path(selected_path)),
        "fontSize": font_size,
        "isValue": is_value,
        "contrastRatio": round(contrast_ratio(PALETTE["white"], PALETTE["panel"]), 2),
    }


def render(job):
    clean_path = Path(job["cleanPath"])
    output_path = Path(job["outputPath"])
    overlay_path = Path(job["overlayPath"])
    guides_path = Path(job["guidesPath"])
    labels_path = Path(job["labelsPath"])
    metadata_path = Path(job["metadataPath"]) if job.get("metadataPath") else None
    spec = job.get("spec") or {}
    layout = job.get("layout") or {}
    kind = str(spec.get("type", "none"))
    labels = [str(value).strip() for value in spec.get("labels", []) if str(value).strip()][:2]
    if kind == "none":
        labels = []

    with Image.open(clean_path) as opened:
        clean = opened.convert("RGBA")
    width, height = clean.size
    guide_layer = Image.new("RGBA", clean.size, (0, 0, 0, 0))
    label_layer = Image.new("RGBA", clean.size, (0, 0, 0, 0))
    guides = ImageDraw.Draw(guide_layer)
    text = ImageDraw.Draw(label_layer)
    stroke = max(4, int(width * 0.007))
    cyan = PALETTE["cyan"]
    amber = PALETTE["amber"]
    red = PALETTE["red"]
    guide_geometry = []

    def point(value):
        if not isinstance(value, dict):
            raise ValueError("INFO 가이드 좌표가 누락되었습니다.")
        x = min(0.98, max(0.02, float(value.get("x"))))
        y = min(0.95, max(0.04, float(value.get("y"))))
        return (int(width * x), int(height * y))

    geometry_mode = str(layout.get("geometryMode", "none" if kind == "none" else ""))
    raw_points = layout.get("guidePoints") or []
    points = [point(value) for value in raw_points]
    label_targets = []
    if geometry_mode == "path":
        if len(points) < 3:
            raise ValueError("경로형 INFO에는 실제 화면 앵커가 3개 이상 필요합니다.")
        if kind == "load_path" and len(points) >= 4:
            source, transfer, left_support, right_support = points[:4]
            guides.line((source, transfer), fill=amber, width=stroke)
            arrow(guides, source, transfer, amber, stroke)
            arrow(guides, transfer, left_support, cyan, stroke)
            arrow(guides, transfer, right_support, cyan, stroke)
            for current, color in ((source, amber), (transfer, PALETTE["white"]), (left_support, cyan), (right_support, cyan)):
                anchor_dot(guides, current, color, max(4, stroke))
            guide_geometry.append({
                "kind": "path",
                "points": [[round(current[0]), round(current[1])] for current in points[:4]],
                "branchCount": 2,
                "downwardProgressPx": round(max(left_support[1], right_support[1]) - source[1], 2),
            })
            label_targets = [source, left_support]
        else:
            geometry = polyline_arrow(guides, points, cyan, stroke)
            geometry["downwardProgressPx"] = round(max(current[1] for current in points[1:]) - points[0][1], 2)
            guide_geometry.append(geometry)
            for index, current in enumerate(points):
                anchor_dot(guides, current, amber if index == 0 else cyan, max(4, stroke))
            label_targets = [points[0], points[-1]]
    elif geometry_mode == "axis_pair":
        if len(points) < 3:
            raise ValueError("축 비교 INFO에는 공통 기초와 두 축 상단이 필요합니다.")
        base, first_top, second_top = points[:3]
        dashed_line(guides, base, first_top, amber, stroke)
        guides.line((base, second_top), fill=cyan, width=stroke)
        anchor_dot(guides, base, PALETTE["white"], max(4, stroke))
        anchor_dot(guides, first_top, amber, max(4, stroke))
        anchor_dot(guides, second_top, cyan, max(4, stroke))
        guide_geometry.append({
            "kind": "axis_pair",
            "sharedBase": list(base),
            "firstTop": list(first_top),
            "secondTop": list(second_top),
            "gapPx": round(math.dist(first_top, second_top), 2),
            "firstAxisLengthPx": round(math.dist(base, first_top), 2),
            "secondAxisLengthPx": round(math.dist(base, second_top), 2),
            "firstOffsetPx": round(abs(first_top[0] - base[0]), 2),
            "secondOffsetPx": round(abs(second_top[0] - base[0]), 2),
        })
        label_targets = [first_top, second_top]
    elif geometry_mode == "position_pair":
        if len(points) < 2:
            raise ValueError("위치 전후 INFO에는 이전과 현재 위치가 필요합니다.")
        before, after = points[:2]
        half_tick = int(width * 0.055)
        guides.line((before[0] - half_tick, before[1], before[0] + half_tick, before[1]), fill=amber, width=stroke)
        guides.line((after[0] - half_tick, after[1], after[0] + half_tick, after[1]), fill=cyan, width=stroke)
        side_x = max(int(width * 0.035), min(before[0], after[0]) - int(width * 0.07))
        guides.line((side_x, before[1], side_x, after[1]), fill=PALETTE["faint"], width=max(2, stroke // 2))
        for y in (before[1], after[1]):
            guides.line((side_x - stroke, y, side_x + stroke, y), fill=PALETTE["white"], width=max(2, stroke // 2))
        if len(points) > 2:
            reference = points[2]
            dashed_line(guides, reference, (side_x, reference[1]), PALETTE["faint"], max(2, stroke // 2))
            anchor_dot(guides, reference, PALETTE["white"], max(3, stroke - 1))
        anchor_dot(guides, before, amber, max(4, stroke))
        anchor_dot(guides, after, cyan, max(4, stroke))
        guide_geometry.append({
            "kind": "position_pair",
            "before": list(before),
            "after": list(after),
            "reference": list(points[2]) if len(points) > 2 else None,
            "gapPx": round(math.dist(before, after), 2),
        })
        label_targets = [before, after]
    elif geometry_mode == "sequence":
        if len(points) < 2:
            raise ValueError("순서 INFO에는 이전과 현재 작업 지점이 필요합니다.")
        previous, current = points[:2]
        control = ((previous[0] + current[0]) / 2, min(previous[1], current[1]) - height * 0.035)
        path_geometry = bezier_arrow(guides, previous, control, current, cyan, max(3, stroke - 1), dashed=True)
        anchor_dot(guides, previous, amber, max(5, stroke + 1))
        anchor_dot(guides, current, cyan, max(5, stroke + 1))
        guide_geometry.append({
            "kind": "sequence",
            "start": list(previous),
            "end": list(current),
            "distancePx": round(math.dist(previous, current), 2),
            "path": path_geometry,
        })
        label_targets = [previous, current]
    elif geometry_mode == "settlement_rotation":
        if len(points) < 3:
            raise ValueError("침하·회전 INFO에는 침하점, 기초 중심, 탑 축 상단이 필요합니다.")
        settle_point, base, current_top = points[:3]
        settle_end = (settle_point[0], min(int(height * 0.95), settle_point[1] + int(height * 0.055)))
        arrow(guides, settle_point, settle_end, amber, stroke)
        guides.line((base, current_top), fill=PALETTE["faint"], width=max(2, stroke // 2))
        target_top = (
            int(base[0] + (current_top[0] - base[0]) * 0.35),
            current_top[1],
        )
        guides.line((base, target_top), fill=cyan, width=stroke)
        control = ((current_top[0] + target_top[0]) / 2, min(current_top[1], target_top[1]) - height * 0.035)
        bezier_arrow(guides, current_top, control, target_top, cyan, max(3, stroke - 1))
        for current, color in ((settle_point, amber), (base, PALETTE["white"]), (current_top, amber), (target_top, cyan)):
            anchor_dot(guides, current, color, max(4, stroke))
        guide_geometry.append({
            "kind": "settlement_rotation",
            "settlementStart": list(settle_point),
            "settlementEnd": list(settle_end),
            "sharedBase": list(base),
            "currentTop": list(current_top),
            "targetTop": list(target_top),
            "settlementDyPx": settle_end[1] - settle_point[1],
            "currentOffsetPx": round(abs(current_top[0] - base[0]), 2),
            "targetOffsetPx": round(abs(target_top[0] - base[0]), 2),
        })
        label_targets = [settle_point, target_top]
    elif geometry_mode == "forbidden":
        if not points:
            raise ValueError("금지 INFO에는 실제 접촉점이 필요합니다.")
        anchor_center = points[0]
        radius = int(width * 0.11)
        guides.ellipse((anchor_center[0] - radius, anchor_center[1] - radius, anchor_center[0] + radius, anchor_center[1] + radius), outline=red, width=stroke * 2)
        guides.line((anchor_center[0] - radius * 0.72, anchor_center[1] - radius * 0.72, anchor_center[0] + radius * 0.72, anchor_center[1] + radius * 0.72), fill=red, width=stroke * 2)
        guide_geometry.append({"kind": "forbidden_action", "center": list(anchor_center), "radiusPx": radius})
        label_targets = [anchor_center]
    elif geometry_mode == "fact_badge":
        if kind not in {"location", "scale_limit"} or str(spec.get("geometryPolicy", "")) != "factual_badge":
            raise ValueError("사실 배지는 명시적 위치·규모 사실 계약에만 사용할 수 있습니다.")
        if points:
            raise ValueError("사실 배지는 물리 끝점·치수선·거리선을 포함할 수 없습니다.")
        if len(labels) != 1:
            raise ValueError("사실 배지는 읽을 수 있는 단일 라벨이 필요합니다.")
    elif geometry_mode == "span":
        if len(points) < 2:
            raise ValueError("범위 INFO에는 두 끝점이 필요합니다.")
        anchor_left, anchor_right = points[:2]
        guides.line((anchor_left, anchor_right), fill=cyan, width=stroke)
        for current in (anchor_left, anchor_right):
            guides.ellipse((current[0] - stroke * 2, current[1] - stroke * 2, current[0] + stroke * 2, current[1] + stroke * 2), fill=cyan)
        guide_geometry.append({
            "kind": kind,
            "start": list(anchor_left),
            "end": list(anchor_right),
            "lengthPx": round(math.dist(anchor_left, anchor_right), 2),
        })
        label_targets = [anchor_left, anchor_right]
    elif kind != "none":
        raise ValueError(f"지원하지 않는 INFO 도형 모드입니다: {geometry_mode}")

    fallback_positions = [
        (int(width * 0.07), int(height * 0.13)),
        (int(width * 0.61), int(height * 0.22)),
        (int(width * 0.08), int(height * 0.54)),
    ]
    raw_label_positions = layout.get("labelPositions") or []

    def label_point(value, fallback):
        if not isinstance(value, dict):
            return fallback
        x = min(0.92, max(0.04, float(value.get("x", fallback[0] / width))))
        y = min(0.70, max(0.06, float(value.get("y", fallback[1] / height))))
        return (int(width * x), int(height * y))

    positions = [
        label_point(raw_label_positions[index] if len(raw_label_positions) > index else None, fallback)
        for index, fallback in enumerate(fallback_positions)
    ]
    colors = [amber, cyan, red if kind == "forbidden_action" else cyan]
    occupied = []
    label_boxes = []
    for index, value in enumerate(labels):
        label_boxes.append(render_label(
            text,
            positions[index],
            value,
            job["labelFontPath"],
            job["valueFontPath"],
            colors[index],
            width,
            height,
            occupied,
        ))
    label_links = []
    for index, label in enumerate(label_boxes):
        if index >= len(label_targets):
            continue
        panel = label["box"]
        target = label_targets[index]
        panel_center = ((panel[0] + panel[2]) / 2, (panel[1] + panel[3]) / 2)
        if math.dist(panel_center, target) < width * 0.08:
            continue
        dashed_line(guides, panel_center, target, PALETTE["faint"], max(2, stroke // 2), dash=10, gap=8)
        label_links.append({
            "label": label["text"],
            "from": [round(panel_center[0]), round(panel_center[1])],
            "to": [round(target[0]), round(target[1])],
            "lengthPx": round(math.dist(panel_center, target), 2),
        })

    overlay = Image.alpha_composite(guide_layer, label_layer)
    alpha = overlay.getchannel("A")
    nonzero = sum(count for value, count in enumerate(alpha.histogram()) if value > 0)
    overlay_coverage = nonzero / max(1, width * height)
    info = Image.alpha_composite(clean, overlay).convert("RGB")
    for target in (output_path, overlay_path, guides_path, labels_path):
        target.parent.mkdir(parents=True, exist_ok=True)
    info.save(output_path, format="PNG", optimize=True)
    overlay.save(overlay_path, format="PNG", optimize=True)
    guide_layer.save(guides_path, format="PNG", optimize=True)
    label_layer.save(labels_path, format="PNG", optimize=True)
    result = {
        "outputPath": str(output_path),
        "overlayPath": str(overlay_path),
        "guidesPath": str(guides_path),
        "labelsPath": str(labels_path),
        "width": width,
        "height": height,
        "type": kind,
        "geometryMode": geometry_mode,
        "layoutConfidence": float(layout.get("confidence", 1 if kind == "none" else 0)),
        "labelCount": len(labels),
        "renderedLabels": labels,
        "labelBoxes": label_boxes,
        "guideGeometry": guide_geometry,
        "labelLinks": label_links,
        "safeCaptionTopPx": int(height * SAFE_CAPTION_TOP_RATIO),
        "overlayCoverage": round(overlay_coverage, 6),
        "fonts": {
            "label": str(Path(job["labelFontPath"])),
            "value": str(Path(job["valueFontPath"])),
        },
    }
    if metadata_path:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        result["metadataPath"] = str(metadata_path)
    return result


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    print(json.dumps(render(job), ensure_ascii=False))


if __name__ == "__main__":
    main()

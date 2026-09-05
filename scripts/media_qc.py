import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, ImageStat


def image_signature(image):
    gray = image.convert("L").resize((32, 32), Image.Resampling.LANCZOS)
    return list(gray.getdata())


def similarity(left, right):
    a = image_signature(left)
    b = image_signature(right)
    mean_error = sum(abs(x - y) for x, y in zip(a, b)) / len(a)
    return max(0.0, 1.0 - mean_error / 255.0)


def edge_strength(image):
    edges = image.convert("L").filter(ImageFilter.FIND_EDGES)
    return float(ImageStat.Stat(edges).mean[0])


def detect_blurred_contain_inset(image):
    width, height = image.size

    def crop(normalized):
        left, top, right, bottom = normalized
        return image.crop((int(width * left), int(height * top), int(width * right), int(height * bottom)))

    def inspect_candidate(bounds, bands):
        center = crop(bounds)
        band_images = {name: crop(region) for name, region in bands.items()}
        center_edges = edge_strength(center)
        edge_scores = {name: edge_strength(band) for name, band in band_images.items()}
        surround_edges = sum(edge_scores.values()) / max(1, len(edge_scores))
        similarities = {
            "topBottom": similarity(band_images["top"], band_images["bottom"]),
            "leftRight": similarity(band_images["left"], band_images["right"]),
        }
        return {
            "centerEdges": center_edges,
            "surroundEdges": surround_edges,
            "sharpnessRatio": center_edges / max(surround_edges, .01),
            "similarities": similarities,
            "edgeScores": edge_scores,
        }

    full_inset_bands = {
        "top": (.08, .03, .92, .12), "bottom": (.08, .88, .92, .97),
        "left": (.03, .08, .12, .92), "right": (.88, .08, .97, .92),
    }
    full = inspect_candidate((.12, .12, .88, .88), full_inset_bands)
    low_edge_pairs = [
        ("top", "bottom", full["similarities"]["topBottom"]),
        ("left", "right", full["similarities"]["leftRight"]),
    ]
    detected_pair = next((pair for pair in low_edge_pairs if (
        full["centerEdges"] >= 16
        and (full["edgeScores"][pair[0]] + full["edgeScores"][pair[1]]) / 2 <= 14
        and full["centerEdges"] / max((full["edgeScores"][pair[0]] + full["edgeScores"][pair[1]]) / 2, .01) >= 1.8
        and pair[2] >= .72
    )), None)

    small_inset_bands = {
        "top": (.27, .08, .73, .22), "bottom": (.27, .78, .73, .92),
        "left": (.05, .33, .18, .67), "right": (.82, .33, .95, .67),
    }
    small = inspect_candidate((.23, .28, .77, .72), small_inset_bands)
    small_detected = (
        small["centerEdges"] >= 18
        and small["surroundEdges"] <= 14
        and small["sharpnessRatio"] >= 2.4
    )
    pattern = "small_inset" if small_detected else "letterbox" if detected_pair and detected_pair[0] == "top" else "pillarbox" if detected_pair else "none"
    detected = pattern != "none"
    return {
        "detected": detected,
        "pattern": pattern,
        "centerEdgeStrength": round(full["centerEdges"], 2),
        "surroundEdgeStrength": round(full["surroundEdges"], 2),
        "sharpnessRatio": round(full["sharpnessRatio"], 2),
        "topBottomSimilarity": round(full["similarities"]["topBottom"], 4),
        "leftRightSimilarity": round(full["similarities"]["leftRight"], 4),
        "edgeStrengths": {name: round(value, 2) for name, value in full["edgeScores"].items()},
        "centralBand": [.12, .12, .76, .76],
        "surroundBands": ["top", "bottom", "left", "right"],
        "smallInset": {
            "bounds": [.23, .28, .54, .44],
            "centerEdgeStrength": round(small["centerEdges"], 2),
            "surroundEdgeStrength": round(small["surroundEdges"], 2),
            "sharpnessRatio": round(small["sharpnessRatio"], 2),
        },
    }


def inspect_image(file_path, references):
    path = Path(file_path)
    errors = []
    warnings = []
    if not path.exists() or path.stat().st_size < 100_000:
        return {"passed": False, "errors": ["파일이 없거나 100KB보다 작습니다."], "warnings": []}

    try:
        with Image.open(path) as opened:
            image = opened.convert("RGB")
            image.load()
    except Exception as exc:
        return {"passed": False, "errors": [f"이미지를 해석할 수 없습니다: {exc}"], "warnings": []}

    width, height = image.size
    ratio = width / height if height else 0
    stats = ImageStat.Stat(image.convert("L"))
    mean = float(stats.mean[0])
    deviation = float(stats.stddev[0])
    if width < 640 or height < 960:
        errors.append(f"해상도가 너무 작습니다: {width}x{height}")
    if abs(ratio - 9 / 16) > 0.07:
        errors.append(f"9:16 세로 비율이 아닙니다: {ratio:.3f}")
    if deviation < 10:
        errors.append("화면 명암 변화가 거의 없어 빈 이미지일 가능성이 큽니다.")
    if mean < 8 or mean > 247:
        errors.append("화면이 거의 검거나 흰색입니다.")

    comparisons = []
    for reference_path in references:
        ref_path = Path(reference_path)
        if not ref_path.exists() or ref_path.resolve() == path.resolve():
            continue
        try:
            with Image.open(ref_path) as opened:
                ref = opened.convert("RGB")
                score = similarity(image, ref)
        except Exception:
            continue
        comparisons.append({"path": str(ref_path), "similarity": round(score, 4)})
    comparisons.sort(key=lambda row: row["similarity"], reverse=True)
    if comparisons and comparisons[0]["similarity"] >= 0.985:
        warnings.append(f"다른 CLEAN과 거의 중복입니다: {comparisons[0]['similarity']:.3f}")
    inset_check = detect_blurred_contain_inset(image)
    if inset_check["detected"]:
        errors.append(f"선명한 중앙 원본과 흐린 주변 여백으로 된 blur+contain {inset_check['pattern']} CLEAN은 허용되지 않습니다.")

    return {
        "passed": not errors,
        "errors": errors,
        "warnings": warnings,
        "width": width,
        "height": height,
        "aspectRatio": round(ratio, 4),
        "meanLuma": round(mean, 2),
        "lumaStdDev": round(deviation, 2),
        "checks": {"blurredContainInset": inset_check},
        "closestReferences": comparisons[:3],
    }


def changed_pixel_count(image):
    histogram = image.convert("L").histogram()
    return sum(histogram[1:])


def boxes_overlap(left, right):
    return not (
        left[2] <= right[0]
        or right[2] <= left[0]
        or left[3] <= right[1]
        or right[3] <= left[1]
    )


def inspect_info(job):
    required_paths = {
        "CLEAN": Path(job["cleanPath"]),
        "INFO": Path(job["infoPath"]),
        "OVERLAY": Path(job["overlayPath"]),
        "GUIDES": Path(job["guidesPath"]),
        "LABELS": Path(job["labelsPath"]),
    }
    errors = []
    warnings = []
    missing = [label for label, path in required_paths.items() if not path.is_file()]
    if missing:
        return {
            "passed": False,
            "errors": [f"INFO 구성 파일이 없습니다: {', '.join(missing)}"],
            "warnings": [],
            "checks": {},
        }

    with Image.open(required_paths["CLEAN"]) as opened:
        clean = opened.convert("RGBA")
    with Image.open(required_paths["INFO"]) as opened:
        info = opened.convert("RGB")
    with Image.open(required_paths["OVERLAY"]) as opened:
        overlay = opened.convert("RGBA")
    with Image.open(required_paths["GUIDES"]) as opened:
        guides = opened.convert("RGBA")
    with Image.open(required_paths["LABELS"]) as opened:
        label_layer = opened.convert("RGBA")

    width, height = clean.size
    same_dimensions = all(image.size == clean.size for image in (info, overlay, guides, label_layer))
    if not same_dimensions:
        errors.append("CLEAN, INFO와 분리 레이어의 해상도가 서로 다릅니다.")
        return {
            "passed": False,
            "errors": errors,
            "warnings": warnings,
            "width": width,
            "height": height,
            "checks": {"sameDimensions": False},
        }

    alpha = overlay.getchannel("A")
    alpha_histogram = alpha.histogram()
    overlay_pixels = sum(alpha_histogram[1:])
    overlay_coverage = overlay_pixels / max(1, width * height)
    kind = str((job.get("spec") or {}).get("type", "none"))
    if kind == "none" and overlay_pixels:
        errors.append("INFO 없음 장면에 그래픽이 추가되었습니다.")
    if kind != "none" and overlay_coverage < 0.0005:
        errors.append("INFO 그래픽이 비어 있거나 지나치게 작습니다.")
    if overlay_coverage > 0.24:
        errors.append(f"INFO 그래픽이 화면을 너무 많이 덮습니다: {overlay_coverage * 100:.1f}%")

    reconstructed = Image.alpha_composite(clean, overlay).convert("RGB")
    reconstruction_diff = ImageChops.difference(reconstructed, info)
    reconstruction_changed = changed_pixel_count(reconstruction_diff)
    if reconstruction_changed:
        errors.append("INFO가 CLEAN과 승인 오버레이의 결정론적 합성 결과와 다릅니다.")

    outside_mask = alpha.point(lambda value: 255 if value == 0 else 0)
    clean_rgb = clean.convert("RGB")
    outside_diff = ImageChops.difference(clean_rgb, info)
    masked_outside = Image.new("RGB", clean.size, (0, 0, 0))
    masked_outside.paste(outside_diff, mask=outside_mask)
    outside_changed = changed_pixel_count(masked_outside)
    if outside_changed:
        errors.append(f"오버레이 바깥에서 CLEAN 픽셀 {outside_changed}개가 변경되었습니다.")

    render = job.get("render") or {}
    spec = job.get("spec") or {}
    expected_labels = [str(value).strip() for value in spec.get("labels", []) if str(value).strip()][:2]
    if kind == "none":
        expected_labels = []
    rendered_labels = [str(value).strip() for value in render.get("renderedLabels", [])]
    labels_match = expected_labels == rendered_labels
    if not labels_match:
        errors.append("렌더된 라벨이 승인 INFO 명세와 일치하지 않습니다.")
    if len(rendered_labels) > 2:
        errors.append("INFO 라벨이 장면당 2개를 초과했습니다.")

    claim_refs = [str(value).strip() for value in job.get("claimRefs", []) if str(value).strip()]
    numeric_labels = [label for label in rendered_labels if re.search(r"\d", label)]
    if numeric_labels and not claim_refs:
        errors.append("근거 주장 없이 숫자 또는 단위가 표시되었습니다.")

    safe_caption_top = int(render.get("safeCaptionTopPx", height * 0.74))
    boxes = []
    for label in render.get("labelBoxes", []):
        box = [int(value) for value in label.get("box", [])]
        if len(box) != 4:
            errors.append("라벨 경계 정보를 읽을 수 없습니다.")
            continue
        boxes.append(box)
        if box[0] < 0 or box[1] < 0 or box[2] > width or box[3] > height:
            errors.append(f"라벨 '{label.get('text', '')}'가 화면 밖으로 잘립니다.")
        if box[3] > safe_caption_top:
            errors.append(f"라벨 '{label.get('text', '')}'가 하단 자막 안전 영역을 침범합니다.")
        minimum_contrast = 3.0 if int(label.get("fontSize", 0)) >= 48 else 4.5
        if float(label.get("contrastRatio", 0)) < minimum_contrast:
            errors.append(f"라벨 '{label.get('text', '')}'의 명암 대비가 부족합니다.")
        font_path = Path(str(label.get("fontPath", "")))
        if not font_path.is_file():
            errors.append(f"라벨 '{label.get('text', '')}'의 Pretendard 글꼴을 확인할 수 없습니다.")
    for index, left in enumerate(boxes):
        for right in boxes[index + 1:]:
            if boxes_overlap(left, right):
                errors.append("INFO 라벨 상자가 서로 겹칩니다.")
                break

    geometry = render.get("guideGeometry", [])
    geometry_mode = str(render.get("geometryMode", ""))
    factual_badge = str(spec.get("geometryPolicy", "")) == "factual_badge"
    if kind != "none" and not geometry and not factual_badge:
        errors.append("INFO 가이드의 앵커 또는 기하정보가 없습니다.")
    expected_modes = {
        "load_path": {"path"},
        "flow": {"path", "settlement_rotation"},
        "sequence": {"sequence"},
        "before_after": {"axis_pair", "position_pair"},
        "comparison": {"axis_pair", "position_pair"},
        "forbidden_action": {"forbidden"},
        "location": {"span", "fact_badge"},
        "scale_limit": {"span", "fact_badge"},
        "none": {"none"},
    }
    if geometry_mode not in expected_modes.get(kind, set()):
        errors.append(f"{kind} 명세와 렌더 도형 모드({geometry_mode or '없음'})가 맞지 않습니다.")
    if geometry_mode == "fact_badge" and not factual_badge:
        errors.append("사실 배지는 명시적 출처 계약이 있어야 합니다.")
    if factual_badge:
        if geometry_mode != "fact_badge" or geometry:
            errors.append("사실 배지는 라벨만 표시하고 물리 끝점·치수선·거리선을 포함할 수 없습니다.")
        if not str(spec.get("evidenceSourceUrl", "")).startswith("https://") or not str(spec.get("evidenceStatement", "")).strip():
            errors.append("사실 배지의 공식 출처 URL 또는 근거 문장이 없습니다.")
    if kind != "none" and not job.get("layoutTrusted", False):
        errors.append("실제 CLEAN 화면에서 확인된 앵커가 없어 INFO를 승인할 수 없습니다.")
    if job.get("manualEdited") and not job.get("provenance"):
        errors.append("수동 편집 INFO는 수정 지시·asset hash·해결 finding provenance 없이는 자동 PASS할 수 없습니다.")
    if kind != "none" and float(render.get("layoutConfidence", 0)) < 0.78:
        errors.append("INFO 앵커 분석 신뢰도가 0.78 미만입니다.")
    for guide in geometry:
        if guide.get("kind") == "arrow" and float(guide.get("lengthPx", 0)) < width * 0.05:
            errors.append("화살표 시작점과 도착점이 너무 가까워 방향을 읽을 수 없습니다.")
        if guide.get("kind") in {"axis_pair", "position_pair"} and float(guide.get("gapPx", 0)) < width * 0.02:
            errors.append("전후 비교의 이전·이후 간격이 보이지 않습니다.")
        if guide.get("kind") == "path" and kind == "load_path" and float(guide.get("downwardProgressPx", 0)) < height * 0.08:
            errors.append("하중 경로가 탑에서 기초를 거쳐 지반 아래로 내려가지 않습니다.")
        if guide.get("kind") == "path" and kind == "load_path":
            path_points = guide.get("points") or []
            if len(path_points) >= 2:
                trunk_dx = abs(float(path_points[1][0]) - float(path_points[0][0]))
                trunk_dy = float(path_points[1][1]) - float(path_points[0][1])
                if trunk_dy <= 0 or trunk_dx > max(width * 0.08, trunk_dy * 0.55):
                    errors.append("하중 경로의 첫 구간이 기초를 향해 아래로 전달되지 않습니다.")
        if guide.get("kind") == "axis_pair":
            if min(float(guide.get("firstAxisLengthPx", 0)), float(guide.get("secondAxisLengthPx", 0))) < height * 0.12:
                errors.append("전후 축이 동일한 기초에서 탑 상부까지 이어지지 않습니다.")
            first_label = rendered_labels[0] if len(rendered_labels) > 0 else ""
            second_label = rendered_labels[1] if len(rendered_labels) > 1 else ""
            first_offset = float(guide.get("firstOffsetPx", 0))
            second_offset = float(guide.get("secondOffsetPx", 0))
            if "현재" in first_label and "위험" in second_label and first_offset >= second_offset:
                errors.append("가상 위험 축이 현재 축보다 더 기울어지지 않았습니다.")
            if "이전" in first_label and "안정화" in second_label and second_offset >= first_offset:
                errors.append("안정화 후 축이 이전 축보다 수직 기준에 가까워지지 않았습니다.")
        if guide.get("kind") == "sequence":
            distance = float(guide.get("distancePx", 0))
            if distance < width * 0.04 or distance > width * 0.60:
                errors.append("작업 순서선이 실제 두 작업 지점을 국부적으로 연결하지 않습니다.")
        if guide.get("kind") == "settlement_rotation":
            if float(guide.get("settlementDyPx", 0)) < height * 0.03:
                errors.append("반대편 기초의 아래 방향 침하가 보이지 않습니다.")
            if float(guide.get("targetOffsetPx", 0)) >= float(guide.get("currentOffsetPx", 0)):
                errors.append("안정화 후 축이 현재 축보다 수직 기준에 가까워지지 않습니다.")

    checks = {
        "sameDimensions": same_dimensions,
        "deterministicComposite": reconstruction_changed == 0,
        "cleanPreservedOutsideOverlay": outside_changed == 0,
        "labelsMatchSpec": labels_match,
        "labelsInsideFrame": all(box[0] >= 0 and box[1] >= 0 and box[2] <= width and box[3] <= height for box in boxes),
        "captionSafeZoneClear": all(box[3] <= safe_caption_top for box in boxes),
        "labelOverlapCount": sum(
            1
            for index, left in enumerate(boxes)
            for right in boxes[index + 1:]
            if boxes_overlap(left, right)
        ),
        "guideGeometryPresent": kind == "none" or factual_badge or bool(geometry),
        "layoutTrusted": kind == "none" or bool(job.get("layoutTrusted", False)),
        "geometryMatchesSpec": geometry_mode in expected_modes.get(kind, set()) and (not factual_badge or (geometry_mode == "fact_badge" and not geometry)),
        "verifiedNumbers": not numeric_labels or bool(claim_refs),
    }
    return {
        "passed": not errors,
        "errors": list(dict.fromkeys(errors)),
        "warnings": list(dict.fromkeys(warnings)),
        "width": width,
        "height": height,
        "aspectRatio": round(width / height, 4) if height else 0,
        "overlayCoverage": round(overlay_coverage, 6),
        "outsideChangedPixels": outside_changed,
        "reconstructionChangedPixels": reconstruction_changed,
        "renderedLabels": rendered_labels,
        "claimRefs": claim_refs,
        "checks": checks,
        "render": render,
    }


def compare_images(left_path, right_path):
    with Image.open(left_path) as left_opened, Image.open(right_path) as right_opened:
        left = left_opened.convert("RGB")
        right = right_opened.convert("RGB")
        right = right.resize(left.size, Image.Resampling.LANCZOS)
        score = similarity(left, right)
        difference = ImageStat.Stat(ImageChops.difference(left, right))
        mean_difference = sum(difference.mean) / 3
    return {"similarity": round(score, 4), "meanPixelDifference": round(mean_difference, 2)}


def main():
    job_path = Path(sys.argv[1])
    job = json.loads(job_path.read_text(encoding="utf-8"))
    if job["mode"] == "image":
        result = inspect_image(job["path"], job.get("references", []))
    elif job["mode"] == "info":
        result = inspect_info(job)
    elif job["mode"] == "compare":
        result = compare_images(job["left"], job["right"])
    else:
        raise ValueError(f"지원하지 않는 QC 모드입니다: {job['mode']}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

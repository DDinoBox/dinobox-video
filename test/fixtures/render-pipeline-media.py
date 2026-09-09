"""Deterministic synthetic sources through the real CLEAN and INFO renderers."""
import contextlib
import io
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "scripts"))
import render_official_photo_clean as clean_renderer
from render_info_overlay import render

destination = Path(sys.argv[1])
clips = []
for index in range(1, 8):
    source = destination / f"source-{index}.png"
    # Portrait raster rounding: preserve the whole synthetic source without recropping.
    image = Image.frombytes("RGB", (480, 853), random.Random(index).randbytes(480 * 853 * 3))
    base = Image.new("RGB", image.size, (25 + index * 12, 65, 95))
    image = Image.blend(base, image, 0.3)
    draw = ImageDraw.Draw(image)
    draw.polygon([(70 + index * 10, 600), (210, 120), (310, 610)], fill=(155, 170 + index * 5, 165))
    draw.rectangle((40, 610, 420, 650), fill=(80, 95, 110))
    image.save(source)
    clean = destination / f"{index:02}_CLEAN.png"
    sys.argv = ["render_official_photo_clean.py", str(source), str(clean)]
    clean_renderer.main()
    required = index <= 2
    spec = {
        "type": "before_after" if required else "none",
        "requiresOverlay": required,
        "labels": ["이전 축", "안정화 후 축"] if required else [],
        "anchors": ["기존 중심선", "보정 중심선"] if required else [],
        "directionRule": "방향 화살표를 사용하지 않는다.",
        "comparisonRule": "같은 기준선 위에 이전과 이후를 놓는다.",
        "forbidden": [],
    }
    layout = {
        "geometryMode": "axis_pair" if required else "none",
        "guidePoints": [{"x": 0.50, "y": 0.68}, {"x": 0.42, "y": 0.24}, {"x": 0.48, "y": 0.24}] if required else [],
        "labelPositions": [{"x": 0.07, "y": 0.14}, {"x": 0.56, "y": 0.24}] if required else [],
        "confidence": 0.94,
        "note": "Synthetic renderer fixture, not a real physical-state claim.",
    }
    evidence = {name: str(destination / f"{index:02}_{name}{'.json' if name == 'renderPath' else '.png'}") for name in ["overlayPath", "guidesPath", "labelsPath", "renderPath"]}
    info = destination / f"{index:02}_INFO.png"
    with contextlib.redirect_stdout(io.StringIO()):
        render({"cleanPath": str(clean), "outputPath": str(info), **{key: value for key, value in evidence.items() if key != "renderPath"},
                "metadataPath": evidence["renderPath"], "spec": spec, "layout": layout,
                "labelFontPath": str(root / "assets/fonts/pretendard/Pretendard-SemiBold.otf"),
                "valueFontPath": str(root / "assets/fonts/pretendard/Pretendard-Bold.otf")})
    clips.append({"key": str(index), "requiredOverlay": required, "infoSpec": spec, "claimRefs": [f"SYNTHETIC-{index}"], "layoutTrusted": True,
                  "infoEvidence": evidence, "cleanPath": str(clean), "infoPath": str(info)})
print(json.dumps(clips, ensure_ascii=False))

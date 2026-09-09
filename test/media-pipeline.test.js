import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.join(root, "tmp");
await mkdir(tempRoot, { recursive: true });
const python = [
  path.join(root, ".venv", "Scripts", "python.exe"),
  "C:\\Users\\com\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe",
  "python"
].find((candidate) => candidate === "python" || existsSync(candidate));

function runPython(args) {
  const result = spawnSync(python, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("deterministic INFO QC accepts the renderer and rejects CLEAN pixel changes", async () => {
  const tempDir = await mkdtemp(path.join(tempRoot, "dinobox-info-qc-"));
  try {
    const cleanPath = path.join(tempDir, "01_CLEAN.png");
    const infoPath = path.join(tempDir, "01_INFO.png");
    const overlayPath = path.join(tempDir, "01_INFO_OVERLAY.png");
    const guidesPath = path.join(tempDir, "01_INFO_GUIDES.png");
    const labelsPath = path.join(tempDir, "01_INFO_LABELS.png");
    const metadataPath = path.join(tempDir, "01_INFO_RENDER.json");
    const labelFontPath = path.join(root, "assets", "fonts", "pretendard", "Pretendard-SemiBold.otf");
    const valueFontPath = path.join(root, "assets", "fonts", "pretendard", "Pretendard-Bold.otf");

    runPython(["-c", [
      "from PIL import Image",
      `p=r'''${cleanPath}'''`,
      "im=Image.new('RGB',(720,1280))",
      "px=im.load()",
      "for y in range(1280):",
      "    for x in range(720):",
      "        px[x,y]=(35+x//8,55+y//18,70+(x+y)//32)",
      "im.save(p)"
    ].join("\n")]);

    const spec = {
      type: "before_after",
      labels: ["이전 축", "안정화 후 축"],
      anchors: ["기존 중심선", "보정 중심선"],
      directionRule: "방향 화살표를 사용하지 않는다.",
      comparisonRule: "같은 기준선 위에 이전과 이후를 놓고 간격 차이를 표시한다.",
      forbidden: []
    };
    const layout = {
      geometryMode: "axis_pair",
      guidePoints: [{ x: 0.50, y: 0.68 }, { x: 0.42, y: 0.24 }, { x: 0.48, y: 0.24 }],
      labelPositions: [{ x: 0.07, y: 0.14 }, { x: 0.56, y: 0.24 }],
      confidence: 0.94,
      note: "synthetic fixture"
    };
    const renderJobPath = path.join(tempDir, "render-job.json");
    await writeFile(renderJobPath, JSON.stringify({
      cleanPath,
      outputPath: infoPath,
      overlayPath,
      guidesPath,
      labelsPath,
      metadataPath,
      spec,
      layout,
      labelFontPath,
      valueFontPath
    }), "utf8");
    const render = JSON.parse(runPython([path.join(root, "scripts", "render_info_overlay.py"), renderJobPath]));

    const qcJobPath = path.join(tempDir, "qc-job.json");
    const qcJob = {
      mode: "info",
      cleanPath,
      infoPath,
      overlayPath,
      guidesPath,
      labelsPath,
      spec,
      render,
      claimRefs: ["CLAIM-01"],
      layoutTrusted: true
    };
    await writeFile(qcJobPath, JSON.stringify(qcJob), "utf8");
    const passed = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), qcJobPath]));
    assert.equal(passed.passed, true, passed.errors?.join(" / "));
    assert.equal(passed.checks.deterministicComposite, true);
    assert.equal(passed.checks.cleanPreservedOutsideOverlay, true);
    assert.equal(passed.checks.captionSafeZoneClear, true);
    assert.equal(passed.checks.layoutTrusted, true);
    assert.equal(passed.checks.geometryMatchesSpec, true);
    assert.equal(render.geometryMode, "axis_pair");
    assert.equal(render.guideGeometry[0].kind, "axis_pair");
    assert.deepEqual(render.guideGeometry[0].sharedBase, [360, 870]);

    const reversedAxisJobPath = path.join(tempDir, "reversed-axis-qc-job.json");
    const reversedRender = structuredClone(render);
    reversedRender.guideGeometry[0].firstOffsetPx = 10;
    reversedRender.guideGeometry[0].secondOffsetPx = 80;
    await writeFile(reversedAxisJobPath, JSON.stringify({ ...qcJob, render: reversedRender }), "utf8");
    const reversedAxis = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), reversedAxisJobPath]));
    assert.equal(reversedAxis.passed, false);
    assert.match(reversedAxis.errors.join(" "), /안정화 후 축/);

    const untrustedJobPath = path.join(tempDir, "untrusted-qc-job.json");
    await writeFile(untrustedJobPath, JSON.stringify({ ...qcJob, layoutTrusted: false }), "utf8");
    const untrusted = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), untrustedJobPath]));
    assert.equal(untrusted.passed, false);
    assert.match(untrusted.errors.join(" "), /확인된 앵커/);

    const nonePaths = Object.fromEntries(["info", "overlay", "guides", "labels", "metadata"].map((name) => [
      name,
      path.join(tempDir, `none-${name}.${name === "metadata" ? "json" : "png"}`)
    ]));
    const noneSpec = {
      type: "none",
      labels: [],
      anchors: [],
      directionRule: "화살표를 사용하지 않는다.",
      comparisonRule: "비교선을 사용하지 않는다.",
      forbidden: []
    };
    const noneRenderJobPath = path.join(tempDir, "none-render-job.json");
    await writeFile(noneRenderJobPath, JSON.stringify({
      cleanPath,
      outputPath: nonePaths.info,
      overlayPath: nonePaths.overlay,
      guidesPath: nonePaths.guides,
      labelsPath: nonePaths.labels,
      metadataPath: nonePaths.metadata,
      spec: noneSpec,
      layout: { geometryMode: "none", guidePoints: [], labelPositions: [], confidence: 1, note: "no overlay" },
      labelFontPath,
      valueFontPath
    }), "utf8");
    const noneRender = JSON.parse(runPython([path.join(root, "scripts", "render_info_overlay.py"), noneRenderJobPath]));
    assert.equal(noneRender.overlayCoverage, 0);
    assert.deepEqual(noneRender.renderedLabels, []);
    const noneQcJobPath = path.join(tempDir, "none-qc-job.json");
    await writeFile(noneQcJobPath, JSON.stringify({
      mode: "info",
      cleanPath,
      infoPath: nonePaths.info,
      overlayPath: nonePaths.overlay,
      guidesPath: nonePaths.guides,
      labelsPath: nonePaths.labels,
      spec: noneSpec,
      render: noneRender,
      claimRefs: [],
      layoutTrusted: true
    }), "utf8");
    const nonePassed = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), noneQcJobPath]));
    assert.equal(nonePassed.passed, true, nonePassed.errors?.join(" / "));
    assert.equal(nonePassed.overlayCoverage, 0);

    const missingGuideJobPath = path.join(tempDir, "missing-guide-qc-job.json");
    await writeFile(missingGuideJobPath, JSON.stringify({ ...qcJob, guidesPath: nonePaths.guides }), "utf8");
    const missingGuide = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), missingGuideJobPath]));
    assert.equal(missingGuide.passed, false, "split layers must reconstruct the published overlay, not just have the same dimensions");
    assert.equal(missingGuide.checks.deterministicLayers, false);

    const requiredNoneJobPath = path.join(tempDir, "required-none-qc-job.json");
    const requiredNoneJob = JSON.parse(await readFile(noneQcJobPath, "utf8"));
    requiredNoneJob.spec.requiresOverlay = true;
    await writeFile(requiredNoneJobPath, JSON.stringify(requiredNoneJob), "utf8");
    const requiredNone = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), requiredNoneJobPath]));
    assert.equal(requiredNone.passed, false, "required INFO must not pass as an unchanged CLEAN copy");
    assert.match(requiredNone.errors.join(" "), /필수 INFO/);

    const subtleInfoPath = path.join(tempDir, "subtle-info.png");
    runPython(["-c", [
      "from PIL import Image",
      `im=Image.open(r'''${infoPath}''').convert('RGB')`,
      "r,g,b=im.getpixel((0,0))",
      "im.putpixel((0,0),(r,g,b+1))",
      `im.save(r'''${subtleInfoPath}''')`
    ].join("\n")]);
    const subtleQcPath = path.join(tempDir, "subtle-qc-job.json");
    await writeFile(subtleQcPath, JSON.stringify({ ...qcJob, infoPath: subtleInfoPath }), "utf8");
    const subtle = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), subtleQcPath]));
    assert.equal(subtle.passed, false, "even a one-level blue-channel change outside the overlay must be rejected");
    assert.equal(subtle.outsideChangedPixels, 1);

    const invisibleOverlayPath = path.join(tempDir, "invisible-overlay.png");
    runPython(["-c", [
      "from PIL import Image",
      `base=Image.open(r'''${cleanPath}''').convert('RGBA')`,
      `mask=Image.open(r'''${overlayPath}''').getchannel('A')`,
      "base.putalpha(mask)",
      `base.save(r'''${invisibleOverlayPath}''')`
    ].join("\n")]);
    const invisibleQcPath = path.join(tempDir, "invisible-qc-job.json");
    await writeFile(invisibleQcPath, JSON.stringify({
      ...qcJob, infoPath: cleanPath, overlayPath: invisibleOverlayPath,
      spec: { ...spec, requiresOverlay: true }
    }), "utf8");
    const invisible = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), invisibleQcPath]));
    assert.ok(invisible.overlayCoverage > 0);
    assert.equal(invisible.passed, false, "non-empty alpha is not proof of a visible INFO overlay");
    assert.equal(invisible.visibleOverlayCoverage, 0);

    runPython(["-c", [
      "from PIL import Image",
      `p=r'''${infoPath}'''`,
      "im=Image.open(p).convert('RGB')",
      "im.putpixel((0,0),(255,0,255))",
      "im.save(p)"
    ].join("\n")]);
    const rejected = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), qcJobPath]));
    assert.equal(rejected.passed, false);
    assert.equal(rejected.checks.cleanPreservedOutsideOverlay, false);
    assert.match(rejected.errors.join(" "), /CLEAN 픽셀/);
    assert.ok((await readFile(metadataPath, "utf8")).includes("labelBoxes"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("official cover renderer crops panels and QC rejects legacy blurred contain insets", async () => {
  const tempDir = await mkdtemp(path.join(tempRoot, "dinobox-official-cover-"));
  try {
    const sourcePath = path.join(tempDir, "source.png");
    const coverPath = path.join(tempDir, "cover.png");
    const legacyPath = path.join(tempDir, "legacy.png");
    const qcJobPath = path.join(tempDir, "qc-job.json");
    runPython(["-c", [
      "from PIL import Image, ImageDraw, ImageFilter, ImageOps",
      `source=r'''${sourcePath}'''`, `legacy=r'''${legacyPath}'''`,
      "im=Image.new('RGB',(2000,1000),(25,40,80))",
      "draw=ImageDraw.Draw(im)",
      "for x in range(0,2000,20): draw.line((x,0,x,1000),fill=((x*7)%255,(x*13)%255,(x*19)%255),width=5)",
      "for y in range(0,1000,20): draw.line((0,y,2000,y),fill=((y*11)%255,(y*17)%255,(y*23)%255),width=4)",
      "draw.rectangle((0,0,399,499),fill=(255,0,0))",
      "for x in range(4,400,8): draw.line((x,0,x,500),fill=(255,(x*11)%255,(x*23)%255),width=3)",
      "for y in range(7,500,9): draw.line((0,y,400,y),fill=(255,(y*17)%255,(y*29)%255),width=2)",
      "im.save(source)",
      "background=ImageOps.fit(im,(941,1672),method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(radius=24))",
      "foreground=ImageOps.contain(im,(941,1672),method=Image.Resampling.LANCZOS)",
      "background.paste(foreground,((941-foreground.width)//2,(1672-foreground.height)//2))",
      "background.save(legacy)"
    ].join("\n")]);
    runPython([path.join(root, "scripts", "render_official_photo_clean.py"), sourcePath, coverPath, "--crop-json", JSON.stringify({ panelCrop: [0, 0, 0.2, 0.5], requiredBounds: [0.05, 0.1, 0.1, 0.3] })]);
    const dimensions = JSON.parse(runPython(["-c", [
      "from PIL import Image",
      `im=Image.open(r'''${coverPath}''')`,
      "print(__import__('json').dumps({'size':im.size,'pixel':im.getpixel((10,10))}))"
    ].join("\n")]));
    assert.deepEqual(dimensions.size, [941, 1672]);
    assert.ok(dimensions.pixel[0] > 240, `panel crop did not select the red source region: ${dimensions.pixel}`);
    await writeFile(qcJobPath, JSON.stringify({ mode: "image", path: legacyPath, references: [] }), "utf8");
    const legacyQc = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), qcJobPath]));
    assert.equal(legacyQc.passed, false);
    assert.equal(legacyQc.checks.blurredContainInset.detected, true);
    await writeFile(qcJobPath, JSON.stringify({ mode: "image", path: coverPath, references: [] }), "utf8");
    const coverQc = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), qcJobPath]));
    assert.equal(coverQc.passed, true, coverQc.errors?.join(" / "));
    assert.equal(coverQc.checks.blurredContainInset.detected, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("official cover renderer uses separately verified two-panel sources in declared order", async () => {
  const tempDir = await mkdtemp(path.join(tempRoot, "dinobox-official-sequence-"));
  try {
    const portPath = path.join(tempDir, "port.png");
    const starboardPath = path.join(tempDir, "starboard.png");
    const coverPath = path.join(tempDir, "sequence-cover.png");
    runPython(["-c", [
      "from PIL import Image",
      `Image.new('RGB',(320,180),(240,30,20)).save(r'''${portPath}''')`,
      `Image.new('RGB',(320,180),(20,50,240)).save(r'''${starboardPath}''')`
    ].join("\n")]);
    const cropJson = JSON.stringify({
      panelSequence: [
        { referenceId: "PORT", sourceUrl: "https://webb.nasa.gov/port", mediaUrl: "https://webb.nasa.gov/port.png", panelCrop: [0, 0, 1, 1] },
        { referenceId: "STARBOARD", sourceUrl: "https://webb.nasa.gov/starboard", mediaUrl: "https://webb.nasa.gov/starboard.png", panelCrop: [0, 0, 1, 1] }
      ]
    });
    const missingInputs = spawnSync(python, [
      path.join(root, "scripts", "render_official_photo_clean.py"), portPath, coverPath,
      "--crop-json", cropJson
    ], { cwd: root, encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.notEqual(missingInputs.status, 0);
    assert.match(missingInputs.stderr || missingInputs.stdout, /requires --panel-sequence-inputs/);
    runPython([
      path.join(root, "scripts", "render_official_photo_clean.py"), portPath, coverPath,
      "--crop-json", cropJson,
      "--panel-sequence-inputs", portPath, starboardPath
    ]);
    const pixels = JSON.parse(runPython(["-c", [
      "from PIL import Image",
      `im=Image.open(r'''${coverPath}''').convert('RGB')`,
      "print(__import__('json').dumps({'top':im.getpixel((470,300)),'bottom':im.getpixel((470,1300))}))"
    ].join("\n")]));
    assert.ok(pixels.top[0] > 200 && pixels.top[2] < 80, `first panel did not use port source: ${pixels.top}`);
    assert.ok(pixels.bottom[2] > 200 && pixels.bottom[0] < 80, `second panel did not use starboard source: ${pixels.bottom}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("media QC rejects synthetic letterbox, pillarbox, and small sharp insets", async () => {
  const tempDir = await mkdtemp(path.join(tempRoot, "dinobox-blur-insets-"));
  try {
    const fixtures = {
      letterbox: path.join(tempDir, "letterbox.png"),
      pillarbox: path.join(tempDir, "pillarbox.png"),
      small_inset: path.join(tempDir, "small-inset.png")
    };
    runPython(["-c", [
      "from PIL import Image, ImageDraw, ImageFilter, ImageOps",
      `letterbox=r'''${fixtures.letterbox}'''`, `pillarbox=r'''${fixtures.pillarbox}'''`, `small_inset=r'''${fixtures.small_inset}'''`,
      "source=Image.new('RGB',(1600,1000),(30,45,70))",
      "draw=ImageDraw.Draw(source)",
      "for x in range(0,1600,16): draw.line((x,0,x,1000),fill=((x*11)%255,(x*17)%255,(x*23)%255),width=4)",
      "for y in range(0,1000,15): draw.line((0,y,1600,y),fill=((y*7)%255,(y*13)%255,(y*19)%255),width=3)",
      "background=ImageOps.fit(source,(941,1672),method=Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(radius=32))",
      "def compose(foreground, output):",
      "    frame=background.copy()",
      "    frame.paste(foreground,((941-foreground.width)//2,(1672-foreground.height)//2))",
      "    frame.save(output)",
      "compose(ImageOps.contain(source.crop((0,200,1600,800)),(941,1672),method=Image.Resampling.LANCZOS),letterbox)",
      "compose(ImageOps.contain(source.crop((600,0,1000,1000)),(941,1672),method=Image.Resampling.LANCZOS),pillarbox)",
      "compose(ImageOps.fit(source,(500,700),method=Image.Resampling.LANCZOS),small_inset)"
    ].join("\n")]);
    for (const [expectedPattern, fixturePath] of Object.entries(fixtures)) {
      const qcJobPath = path.join(tempDir, `${expectedPattern}.json`);
      await writeFile(qcJobPath, JSON.stringify({ mode: "image", path: fixturePath, references: [] }), "utf8");
      const result = JSON.parse(runPython([path.join(root, "scripts", "media_qc.py"), qcJobPath]));
      assert.equal(result.passed, false, `${expectedPattern} should be rejected`);
      assert.equal(result.checks.blurredContainInset.pattern, expectedPattern);
      assert.match(result.errors.join(" "), /흐린 주변 여백/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("media QC rejects the three real approved blurred-contain failures at multiple resolutions", () => {
  const results = JSON.parse(runPython(["-B", "-c", [
    "import hashlib, json, runpy",
    "from pathlib import Path",
    "from PIL import Image",
    "qc=runpy.run_path('scripts/media_qc.py')",
    "results=[]",
    "fixtures=Path('test/fixtures/media')",
    "for case in json.loads((fixtures/'provenance.json').read_text(encoding='utf-8'))['cases']:",
    "    source=fixtures/case['file']",
    "    assert hashlib.sha256(source.read_bytes()).hexdigest()==case['sha256'], source.name",
    "    with Image.open(source) as opened:",
    "        image=opened.convert('RGB')",
    "        variants={'native':image,'resized':image.resize((720,1280),Image.Resampling.LANCZOS),'pillarbox':image.transpose(Image.Transpose.ROTATE_90)}",
    "        results.append({'file':source.name,'qc':qc['inspect_image'](source,[]),'variants':{name:qc['detect_blurred_contain_inset'](frame) for name,frame in variants.items()}})",
    "print(json.dumps(results))"
  ].join("\n")]));
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.qc.passed, false, `${result.file} must not retain its historical false PASS`);
    assert.match(result.qc.errors.join(" "), /blur\+contain/);
    for (const [variant, qc] of Object.entries(result.variants)) {
      assert.equal(qc.detected, true, `${result.file}/${variant}`);
      assert.equal(qc.pattern, variant === "pillarbox" ? "pillarbox" : "letterbox");
    }
  }
});

test("media QC keeps full-bleed photos, low contrast, and gradual depth of field valid", () => {
  const results = JSON.parse(runPython(["-B", "-c", [
    "import json, runpy",
    "from pathlib import Path",
    "from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageDraw",
    "qc=runpy.run_path('scripts/media_qc.py')",
    "results=[]",
    "for source in sorted(Path('test/fixtures/media').glob('glen-canyon-blurred-contain-*.png')):",
    "    with Image.open(source) as opened:",
    "        image=opened.convert('RGB')",
    "        foreground=image.crop((0,round(image.height*.29)+3,image.width,round(image.height*.71)-3))",
    "        cover=ImageOps.fit(foreground,(720,1280),method=Image.Resampling.LANCZOS)",
    "        mask=Image.new('L',cover.size,0)",
    "        ImageDraw.Draw(mask).ellipse((100,300,620,1000),fill=255)",
    "        mask=mask.filter(ImageFilter.GaussianBlur(90))",
    "        depth=Image.composite(cover,cover.filter(ImageFilter.GaussianBlur(20)),mask)",
    "        variants={'cover':cover,'low_contrast':ImageEnhance.Contrast(cover).enhance(.45),'depth_of_field':depth,'landscape':foreground}",
    "        results.extend({'file':source.name,'variant':name,'qc':qc['detect_blurred_contain_inset'](frame)} for name,frame in variants.items())",
    "print(json.dumps(results))"
  ].join("\n")]));
  assert.equal(results.length, 12);
  for (const result of results) {
    assert.equal(result.qc.detected, false, `${result.file}/${result.variant}: ${JSON.stringify(result.qc)}`);
  }
});

test("media QC records letterbox, pillarbox, and small inset blur geometry", async () => {
  const source = await readFile(path.join(root, "scripts", "media_qc.py"), "utf8");
  assert.match(source, /"left"/);
  assert.match(source, /"right"/);
  assert.match(source, /"letterbox"/);
  assert.match(source, /"pillarbox"/);
  assert.match(source, /"small_inset"/);
  assert.match(source, /leftRightSimilarity/);
  assert.match(source, /smallInset/);
});

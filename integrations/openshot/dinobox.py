"""Import a DinoBox edit manifest into a native OpenShot timeline."""

import json
import os

import openshot
from PyQt5.QtCore import QTimer
from PyQt5.QtGui import QFontDatabase

from classes.app import get_app
from classes.image_types import get_media_type
from classes.logger import log
from classes.query import Clip, File, Track


def _constant_keyframe(value):
    return {
        "Points": [
            {
                "co": {"X": 1.0, "Y": float(value)},
                "interpolation": 2,
            }
        ]
    }


def _ensure_file(media_path):
    existing = File.get(path=media_path)
    if existing:
        return existing, openshot.Clip(media_path)

    source_clip = openshot.Clip(media_path)
    reader_data = json.loads(source_clip.Reader().Json())
    reader_data["media_type"] = get_media_type(reader_data)
    project_file = File()
    project_file.data = reader_data
    project_file.save()
    return project_file, source_clip


def _add_caption_effect(clip_data, media):
    caption_text = str(media.get("captionText", "") or "").strip()
    if not caption_text:
        return

    style = media.get("captionStyle") or {}
    effect = openshot.EffectInfo().CreateEffect("Caption")
    effect.Id(get_app().project.generate_id())
    effect_data = json.loads(effect.Json())
    effect_data["caption_text"] = caption_text

    selected_font = style.get("fontFamily") if style.get("fontInstalled") else style.get("fallbackFontFamily")
    font_path = os.path.abspath(style.get("fontPath", "")) if style.get("fontPath") else ""
    if font_path and os.path.isfile(font_path):
        font_id = QFontDatabase.addApplicationFont(font_path)
        if font_id >= 0:
            families = QFontDatabase.applicationFontFamilies(font_id)
            if families:
                selected_font = families[0]
    string_values = {
        "caption_font": selected_font or style.get("fallbackFontFamily"),
    }
    keyframe_values = {
        "font_size": style.get("fontSize"),
        "stroke_width": style.get("strokeWidth"),
        "top": style.get("top"),
        "left": style.get("left"),
        "right": style.get("right"),
    }
    for key, value in string_values.items():
        if key in effect_data and value:
            effect_data[key] = value
    for key, value in keyframe_values.items():
        if key in effect_data and value is not None:
            effect_data[key] = _constant_keyframe(value)

    effects = clip_data.get("effects") or []
    effects.append(effect_data)
    clip_data["effects"] = effects


def _add_clip(media, layer, video_enabled, audio_enabled):
    media_path = os.path.abspath(media["path"])
    if not os.path.isfile(media_path):
        raise FileNotFoundError(media_path)

    project_file, source_clip = _ensure_file(media_path)
    clip = Clip()
    clip.data = json.loads(source_clip.Json())
    clip.data["file_id"] = project_file.id
    clip.data["title"] = media.get("title") or os.path.basename(media_path)
    clip.data["layer"] = layer
    clip.data["position"] = float(media.get("position", 0.0))
    clip.data["start"] = float(media.get("sourceStart", 0.0))
    clip.data["end"] = clip.data["start"] + float(media["duration"])
    clip.data["has_video"] = _constant_keyframe(1 if video_enabled else 0)
    clip.data["has_audio"] = _constant_keyframe(1 if audio_enabled else 0)
    _add_caption_effect(clip.data, media)
    clip.save()


def import_manifest(manifest_path):
    app = get_app()
    with open(manifest_path, "r", encoding="utf-8") as stream:
        manifest = json.load(stream)

    profile = openshot.Profile(os.path.abspath(manifest["profilePath"]))
    app.window.actionProfile_trigger(profile)

    existing_layers = app.project.get("layers") or []
    highest_layer = max((layer.get("number", 0) for layer in existing_layers), default=0)

    audio_track = Track()
    audio_track.data = {
        "number": highest_layer + 1000000,
        "y": 0,
        "label": "DinoBox TTS",
        "lock": False,
    }
    audio_track.save()

    video_track = Track()
    video_track.data = {
        "number": highest_layer + 2000000,
        "y": 0,
        "label": "DinoBox Video",
        "lock": False,
    }
    video_track.save()

    for media in manifest.get("videoClips", []):
        _add_clip(media, video_track.data["number"], True, False)

    narration = manifest.get("narration")
    if narration:
        _add_clip(narration, audio_track.data["number"], False, True)

    output_path = os.path.abspath(manifest["outputPath"])
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    app.window.save_project(output_path)
    app.window.refreshFrameSignal.emit()
    app.window.SetWindowTitle()
    log.info("DinoBox edit project created: %s", output_path)
    if manifest.get("buildOnly"):
        QTimer.singleShot(0, app.quit)

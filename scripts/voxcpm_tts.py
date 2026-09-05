import json
import os
import sys
import traceback


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def styled_text(style, text):
    style = (style or "").strip()
    text = (text or "").strip()
    if not style:
        return text
    return f"({style}){text}"


def should_apply_style(job):
    reference_audio_path = (job.get("referenceAudioPath") or "").strip()
    prompt_wav_path = (job.get("promptWavPath") or "").strip()
    return not reference_audio_path and not prompt_wav_path


def main():
    if len(sys.argv) < 2:
        fail("job json path is required")

    job_path = sys.argv[1]
    with open(job_path, "r", encoding="utf-8") as file:
        job = json.load(file)

    try:
        import numpy as np
        import soundfile as sf
        import torch
        from voxcpm import VoxCPM
    except Exception as exc:
        fail(
            "VoxCPM 런타임이 설치되지 않았습니다. "
            "필요 패키지: voxcpm, torch, soundfile. "
            f"원인: {exc}"
        )

    try:
        seed = int(job.get("seed", 42))
        np.random.seed(seed)
        torch.manual_seed(seed)

        model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
        sample_rate = getattr(getattr(model, "tts_model", None), "sample_rate", 48000)
        outputs = []
        chunks = []
        gap_sec = float(job.get("gapSec", 0.0) or 0.0)
        gap = np.zeros(int(sample_rate * gap_sec), dtype=np.float32)

        for item in job.get("outputs", []):
            output_path = item["path"]
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            text = styled_text(job.get("styleInstruction"), item.get("text")) if should_apply_style(job) else (item.get("text") or "").strip()
            kwargs = {
                "text": text,
                "cfg_value": 2.0,
                "inference_timesteps": 10,
            }
            reference_audio_path = (job.get("referenceAudioPath") or "").strip()
            if reference_audio_path:
                kwargs["reference_wav_path"] = reference_audio_path
            prompt_wav_path = (job.get("promptWavPath") or "").strip()
            prompt_text = (job.get("promptText") or "").strip()
            if prompt_wav_path and prompt_text:
                kwargs["prompt_wav_path"] = prompt_wav_path
                kwargs["prompt_text"] = prompt_text

            wav = model.generate(**kwargs)
            wav = np.asarray(wav, dtype=np.float32)
            sf.write(output_path, wav, sample_rate)
            duration = round(float(len(wav)) / float(sample_rate), 3)
            outputs.append({
                "index": item.get("index"),
                "path": output_path,
                "durationSec": duration,
            })
            chunks.append(wav)
            if gap_sec > 0:
                chunks.append(gap)

        master = None
        output_master_path = (job.get("outputMasterPath") or "").strip()
        if output_master_path and chunks:
            if gap_sec > 0 and len(chunks) > 1:
                chunks = chunks[:-1]
            merged = np.concatenate(chunks)
            os.makedirs(os.path.dirname(output_master_path), exist_ok=True)
            sf.write(output_master_path, merged, sample_rate)
            master = {
                "path": output_master_path,
                "durationSec": round(float(len(merged)) / float(sample_rate), 3),
            }

        print(json.dumps({
            "ok": True,
            "sampleRate": sample_rate,
            "outputs": outputs,
            "master": master,
        }, ensure_ascii=False))
    except Exception:
        fail(traceback.format_exc())


if __name__ == "__main__":
    main()

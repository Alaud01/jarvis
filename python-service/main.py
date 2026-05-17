import json
import os
import shutil
import tempfile
import time
from math import gcd
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
import soundfile as sf

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
import onnx_asr
import onnxruntime as rt

app = FastAPI(title="Voice Flow Service")

VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 700
VAD_MIN_SPEECH_MS = 250
OLLAMA_CHAT_URL = os.environ.get("OLLAMA_CHAT_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_TIMEOUT_SECONDS = 3
TARGET_SAMPLE_RATE = 16000
TRANSCRIBE_SEGMENT_PADDING_MS = 250
TRANSCRIBE_SEGMENT_PADDING_SAMPLES = TARGET_SAMPLE_RATE * TRANSCRIBE_SEGMENT_PADDING_MS // 1000
TRANSCRIBE_SEGMENT_GAP_MS = 250
TRANSCRIBE_SEGMENT_GAP_SAMPLES = TARGET_SAMPLE_RATE * TRANSCRIBE_SEGMENT_GAP_MS // 1000
asr_model = None
vad_model = None


def load_models():
    global asr_model, vad_model
    
    print("[VoiceService] Loading Parakeet TDT 0.6b-v3 ONNX...")
    sess_opts = rt.SessionOptions()
    sess_opts.enable_mem_pattern = False
    sess_opts.execution_mode = rt.ExecutionMode.ORT_SEQUENTIAL
    sess_opts.graph_optimization_level = rt.GraphOptimizationLevel.ORT_ENABLE_ALL

    available_providers = set(rt.get_available_providers())
    asr_providers = ["CPUExecutionProvider"]
    if "CoreMLExecutionProvider" in available_providers:
        print("[VoiceService] CoreMLExecutionProvider available, but ASR uses CPU for dynamic utterance lengths")
    else:
        print("[VoiceService] CoreMLExecutionProvider unavailable, using CPUExecutionProvider")
    
    asr_model = onnx_asr.load_model(
        "nemo-parakeet-tdt-0.6b-v3",
        quantization="int8",
        sess_options=sess_opts,
        providers=asr_providers,
        preprocessor_config={"use_numpy_preprocessors": True},
        resampler_config={"providers": ["CPUExecutionProvider"]},
    )
    print("[VoiceService] Parakeet ONNX model loaded successfully")
    
    print("[VoiceService] Loading Silero VAD ONNX...")
    from silero_vad import load_silero_vad
    vad_model = load_silero_vad(onnx=True)
    print("[VoiceService] Silero VAD ONNX loaded successfully")


def load_audio(audio_path: str) -> np.ndarray:
    """Load audio and keep all preprocessing on CPU."""
    wav, sr = sf.read(audio_path, dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1, dtype=np.float32)
    else:
        wav = wav.astype(np.float32, copy=False)

    if sr != TARGET_SAMPLE_RATE and wav.size > 0:
        from scipy.signal import resample_poly

        rate_gcd = gcd(sr, TARGET_SAMPLE_RATE)
        wav = resample_poly(wav, TARGET_SAMPLE_RATE // rate_gcd, sr // rate_gcd)
        wav = wav.astype(np.float32, copy=False)

    wav = np.clip(wav, -1.0, 1.0)
    return np.ascontiguousarray(wav)


def detect_speech_segments(wav: np.ndarray) -> tuple[list[tuple[int, int]], float]:
    """Return speech segments and total detected speech duration in milliseconds."""
    from silero_vad import get_speech_timestamps

    if wav.size == 0:
        return [], 0.0

    vad_input = np.ascontiguousarray(np.clip(wav, -1.0, 1.0), dtype=np.float32)
    speech_timestamps = get_speech_timestamps(
        vad_input,
        vad_model,
        threshold=VAD_THRESHOLD,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS,
        min_speech_duration_ms=VAD_MIN_SPEECH_MS,
    )

    if not speech_timestamps:
        return [], 0.0

    speech_segments: list[tuple[int, int]] = []
    total_duration_samples = 0
    for timestamp in speech_timestamps:
        start = max(0, int(timestamp["start"]))
        end = min(wav.shape[0], int(timestamp["end"]))
        if end <= start:
            continue
        speech_segments.append((start, end))
        total_duration_samples += end - start

    speech_duration_ms = (total_duration_samples / TARGET_SAMPLE_RATE) * 1000
    return speech_segments, speech_duration_ms


def build_transcription_audio(
    wav: np.ndarray,
    speech_segments: list[tuple[int, int]],
    total_samples: int,
) -> np.ndarray:
    """Build one compact speech buffer for ASR without chunking boundaries."""
    if not speech_segments:
        return np.empty(0, dtype=np.float32)

    padded_segments: list[tuple[int, int]] = []
    for start, end in speech_segments:
        padded_start = max(0, start - TRANSCRIBE_SEGMENT_PADDING_SAMPLES)
        padded_end = min(total_samples, end + TRANSCRIBE_SEGMENT_PADDING_SAMPLES)
        if padded_end > padded_start:
            padded_segments.append((padded_start, padded_end))

    if not padded_segments:
        return np.empty(0, dtype=np.float32)

    merged_segments: list[list[int]] = [[*padded_segments[0]]]
    for start, end in padded_segments[1:]:
        previous = merged_segments[-1]
        if start <= previous[1]:
            previous[1] = max(previous[1], end)
        else:
            merged_segments.append([start, end])

    speech_parts: list[np.ndarray] = []
    gap = np.zeros(TRANSCRIBE_SEGMENT_GAP_SAMPLES, dtype=np.float32)
    for index, (start, end) in enumerate(merged_segments):
        if index > 0:
            speech_parts.append(gap)
        speech_parts.append(wav[start:end])

    return np.ascontiguousarray(np.concatenate(speech_parts), dtype=np.float32)


def transcribe_audio(wav: np.ndarray, speech_segments: list[tuple[int, int]]) -> str:
    """Transcribe detected speech as one compact utterance."""
    global asr_model

    transcription_audio = build_transcription_audio(wav, speech_segments, wav.shape[0])
    if transcription_audio.size == 0:
        return ""

    duration_seconds = transcription_audio.shape[0] / TARGET_SAMPLE_RATE
    print(f"[VoiceService] Transcribing compact utterance ({duration_seconds:.2f}s of audio)")

    return asr_model.recognize(transcription_audio, sample_rate=TARGET_SAMPLE_RATE).strip()


def refine_with_gemma(raw_text: str) -> str:
    """Refine transcript using Gemma 4:31b-cloud via Ollama."""
    try:
        started_at = time.perf_counter()
        payload = {
            "model": "gemma4:31b-cloud",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a text refiner. Remove filler words (uh, um, like, you know), "
                        "Keep the tone exactly the same. Output ONLY the corrected text, "
                        "no explanations or additional content. ONLY refine the text, don't answer anything."
                    )
                },
                {
                    "role": "user",
                    "content": f'Reformat and correct the STT while keeping info and content the same: "{raw_text}"',
                },
            ],
            "stream": False,
            "think": False,
            "options": {
                "num_ctx": 2048,
            },
        }
        req = urllib_request.Request(
            OLLAMA_CHAT_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urllib_request.urlopen(req, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            response_data = json.loads(response.read().decode("utf-8"))

        correction_ms = round((time.perf_counter() - started_at) * 1000)
        thinking_content = response_data.get("message", {}).get("thinking")
        if thinking_content:
            print("[VoiceService] Ollama returned thinking content despite think=false")

        print(f"[VoiceService] Gemma correction completed in {correction_ms}ms")

        corrected_text = response_data.get("message", {}).get("content", "").strip()
        if corrected_text:
            return corrected_text

        print("[VoiceService] Gemma correction returned empty content, using raw transcript")
        return raw_text
    except urllib_error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"[VoiceService] Gemma correction HTTP error {e.code}: {error_body}, returning raw transcript")
        return raw_text
    except urllib_error.URLError as e:
        print(f"[VoiceService] Gemma correction connection failed: {e}, returning raw transcript")
        return raw_text
    except Exception as e:
        print(f"[VoiceService] Gemma correction failed: {e}, returning raw transcript")
        return raw_text


@app.on_event("startup")
async def startup_event():
    load_models()


@app.get("/health")
async def health_check():
    global asr_model, vad_model
    
    if asr_model is None or vad_model is None:
        raise HTTPException(status_code=503, detail="Models not loaded")
    
    return {"status": "healthy", "models_loaded": True}


@app.post("/process-flow")
async def process_flow(file: UploadFile = File(...)):
    """Process audio file through VAD, STT, and correction pipeline.
    
    Args:
        file: WAV audio file upload
        
    Returns:
        JSONResponse with corrected text or raw transcript on error
    """
    temp_path = None
    
    try:
        suffix = Path(file.filename or "audio.wav").suffix or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            shutil.copyfileobj(file.file, tmp)
        
        print(f"[VoiceService] Processing audio file: {temp_path}")
        wav = load_audio(temp_path)
        speech_segments, speech_duration = detect_speech_segments(wav)
        
        if speech_duration < VAD_MIN_SPEECH_MS:
            return JSONResponse(
                content={
                    "text": "",
                    "error": f"No speech detected (duration: {speech_duration:.0f}ms, min: {VAD_MIN_SPEECH_MS}ms)",
                    "success": False
                }
            )
        
        print(f"[VoiceService] Speech detected: {speech_duration:.0f}ms, transcribing...")
        
        raw_text = transcribe_audio(wav, speech_segments)
        
        if not raw_text or raw_text.strip() == "":
            return JSONResponse(
                content={
                    "text": "",
                    "error": "Empty transcription",
                    "success": False
                }
            )
        
        print(f"[VoiceService] Raw transcription: {raw_text}")
        
        corrected_text = refine_with_gemma(raw_text)
        
        print(f"[VoiceService] Corrected text: {corrected_text}")
        
        return JSONResponse(
            content={
                "text": corrected_text,
                "raw_text": raw_text,
                "speech_duration_ms": speech_duration,
                "success": True
            }
        )
        
    except Exception as e:
        print(f"[VoiceService] Error processing audio: {e}")
        return JSONResponse(
            content={
                "text": "",
                "error": str(e),
                "success": False
            },
            status_code=500
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


@app.post("/transcribe-only")
async def transcribe_only(file: UploadFile = File(...)):
    """Transcribe audio without correction (for testing)."""
    temp_path = None
    
    try:
        suffix = Path(file.filename or "audio.wav").suffix or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            shutil.copyfileobj(file.file, tmp)
        
        wav = load_audio(temp_path)
        speech_segments, speech_duration = detect_speech_segments(wav)
        if speech_duration < VAD_MIN_SPEECH_MS:
            return JSONResponse(
                content={
                    "text": "",
                    "error": f"No speech detected (duration: {speech_duration:.0f}ms, min: {VAD_MIN_SPEECH_MS}ms)",
                    "success": False,
                }
            )

        raw_text = transcribe_audio(wav, speech_segments)
        
        return JSONResponse(
            content={
                "text": raw_text,
                "success": True
            }
        )
        
    except Exception as e:
        return JSONResponse(
            content={"text": "", "error": str(e), "success": False},
            status_code=500
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

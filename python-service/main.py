import json
import os
import tempfile
import time
from math import gcd
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
import soundfile as sf

from fastapi import FastAPI, UploadFile, File, HTTPException, status
from fastapi.responses import JSONResponse
import onnx_asr
import onnxruntime as rt

app = FastAPI(title="Voice Flow Service")

VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 700
VAD_MIN_SPEECH_MS = 250
OLLAMA_CHAT_URL = os.environ.get("OLLAMA_CHAT_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_TIMEOUT_SECONDS = 3
OLLAMA_REFINEMENT_KEEP_ALIVE = 0
TARGET_SAMPLE_RATE = 16000
TRANSCRIBE_SEGMENT_PADDING_MS = 250
TRANSCRIBE_SEGMENT_PADDING_SAMPLES = TARGET_SAMPLE_RATE * TRANSCRIBE_SEGMENT_PADDING_MS // 1000
TRANSCRIBE_SEGMENT_GAP_MS = 250
TRANSCRIBE_SEGMENT_GAP_SAMPLES = TARGET_SAMPLE_RATE * TRANSCRIBE_SEGMENT_GAP_MS // 1000
MAX_UPLOAD_BYTES = int(os.environ.get("VOICE_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
MAX_RECORDING_SECONDS = float(os.environ.get("VOICE_MAX_RECORDING_SECONDS", "300"))
MAX_COMPACT_TRANSCRIPTION_SECONDS = float(os.environ.get("VOICE_MAX_COMPACT_TRANSCRIPTION_SECONDS", "45"))
MAX_COMPACT_TRANSCRIPTION_SAMPLES = int(TARGET_SAMPLE_RATE * MAX_COMPACT_TRANSCRIPTION_SECONDS)
UPLOAD_COPY_CHUNK_BYTES = 1024 * 1024
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


def copy_upload_to_temp(file: UploadFile, suffix: str) -> tuple[str, int]:
    """Copy an upload to disk while enforcing a hard byte limit."""
    total_bytes = 0
    temp_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            while True:
                chunk = file.file.read(UPLOAD_COPY_CHUNK_BYTES)
                if not chunk:
                    break

                total_bytes += len(chunk)
                if total_bytes > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"Audio upload too large ({total_bytes} bytes, max: {MAX_UPLOAD_BYTES} bytes)",
                    )

                tmp.write(chunk)
    except Exception:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        raise

    return temp_path, total_bytes


def ensure_audio_within_limits(audio_path: str) -> None:
    info = sf.info(audio_path)
    duration_seconds = info.duration
    if duration_seconds > MAX_RECORDING_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"Recording too long ({duration_seconds:.1f}s, "
                f"max: {MAX_RECORDING_SECONDS:.1f}s)"
            ),
        )


def clip_in_place(wav: np.ndarray) -> np.ndarray:
    if wav.size == 0:
        return wav

    if np.nanmin(wav) < -1.0 or np.nanmax(wav) > 1.0:
        np.clip(wav, -1.0, 1.0, out=wav)

    return wav


def load_audio(audio_path: str) -> np.ndarray:
    """Load audio and keep all preprocessing on CPU."""
    ensure_audio_within_limits(audio_path)

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

    wav = clip_in_place(wav)
    if not wav.flags.c_contiguous:
        wav = np.ascontiguousarray(wav)

    return wav


def detect_speech_segments(wav: np.ndarray) -> tuple[list[tuple[int, int]], float]:
    """Return speech segments and total detected speech duration in milliseconds."""
    from silero_vad import get_speech_timestamps

    if wav.size == 0:
        return [], 0.0

    speech_timestamps = get_speech_timestamps(
        wav,
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


def describe_audio(wav: np.ndarray) -> dict[str, float]:
    if wav.size == 0:
        return {"duration_ms": 0.0, "peak": 0.0, "rms": 0.0}

    peak = float(np.max(np.abs(wav)))
    rms = float(np.sqrt(np.mean(np.square(wav.astype(np.float64, copy=False)))))
    return {
        "duration_ms": (wav.shape[0] / TARGET_SAMPLE_RATE) * 1000,
        "peak": peak,
        "rms": rms,
    }


def build_transcription_audio(
    wav: np.ndarray,
    speech_segments: list[tuple[int, int]],
    total_samples: int,
) -> np.ndarray:
    """Build one compact speech buffer for ASR without chunking boundaries."""
    return build_transcription_chunk(wav, merge_padded_speech_segments(speech_segments, total_samples))


def merge_padded_speech_segments(
    speech_segments: list[tuple[int, int]],
    total_samples: int,
) -> list[tuple[int, int]]:
    padded_segments: list[tuple[int, int]] = []
    for start, end in speech_segments:
        padded_start = max(0, start - TRANSCRIBE_SEGMENT_PADDING_SAMPLES)
        padded_end = min(total_samples, end + TRANSCRIBE_SEGMENT_PADDING_SAMPLES)
        if padded_end > padded_start:
            padded_segments.append((padded_start, padded_end))

    if not padded_segments:
        return []

    merged_segments: list[list[int]] = [[*padded_segments[0]]]
    for start, end in padded_segments[1:]:
        previous = merged_segments[-1]
        if start <= previous[1]:
            previous[1] = max(previous[1], end)
        else:
            merged_segments.append([start, end])

    return [(start, end) for start, end in merged_segments]


def compact_sample_count(segments: list[tuple[int, int]]) -> int:
    if not segments:
        return 0

    speech_samples = sum(end - start for start, end in segments)
    gap_samples = TRANSCRIBE_SEGMENT_GAP_SAMPLES * (len(segments) - 1)
    return speech_samples + gap_samples


def build_transcription_chunk(wav: np.ndarray, segments: list[tuple[int, int]]) -> np.ndarray:
    if not segments:
        return np.empty(0, dtype=np.float32)

    if len(segments) == 1:
        start, end = segments[0]
        chunk = wav[start:end]
        if chunk.dtype == np.float32 and chunk.flags.c_contiguous:
            return chunk
        return np.ascontiguousarray(chunk, dtype=np.float32)

    chunk_samples = compact_sample_count(segments)
    chunk = np.empty(chunk_samples, dtype=np.float32)
    offset = 0
    for index, (start, end) in enumerate(segments):
        if index > 0:
            gap_end = offset + TRANSCRIBE_SEGMENT_GAP_SAMPLES
            chunk[offset:gap_end].fill(0)
            offset = gap_end

        segment = wav[start:end]
        segment_end = offset + segment.shape[0]
        chunk[offset:segment_end] = segment
        offset = segment_end

    return chunk


def iter_transcription_chunks(
    wav: np.ndarray,
    speech_segments: list[tuple[int, int]],
) -> tuple[list[np.ndarray], float]:
    """Return bounded ASR chunks and their compact duration in seconds."""
    merged_segments = merge_padded_speech_segments(speech_segments, wav.shape[0])
    if not merged_segments:
        return [], 0.0

    total_compact_samples = compact_sample_count(merged_segments)
    if total_compact_samples <= MAX_COMPACT_TRANSCRIPTION_SAMPLES:
        return [build_transcription_chunk(wav, merged_segments)], total_compact_samples / TARGET_SAMPLE_RATE

    chunks: list[np.ndarray] = []
    current_segments: list[tuple[int, int]] = []
    current_samples = 0

    for segment in merged_segments:
        segment_samples = segment[1] - segment[0]
        additional_samples = segment_samples
        if current_segments:
            additional_samples += TRANSCRIBE_SEGMENT_GAP_SAMPLES

        if current_segments and current_samples + additional_samples > MAX_COMPACT_TRANSCRIPTION_SAMPLES:
            chunks.append(build_transcription_chunk(wav, current_segments))
            current_segments = []
            current_samples = 0
            additional_samples = segment_samples

        current_segments.append(segment)
        current_samples += additional_samples

    if current_segments:
        chunks.append(build_transcription_chunk(wav, current_segments))

    return chunks, total_compact_samples / TARGET_SAMPLE_RATE


def transcribe_audio(wav: np.ndarray, speech_segments: list[tuple[int, int]]) -> str:
    """Transcribe detected speech, chunking very long recordings to bound peak memory."""
    global asr_model

    transcription_chunks, duration_seconds = iter_transcription_chunks(wav, speech_segments)
    if not transcription_chunks:
        return ""

    if len(transcription_chunks) == 1:
        print(f"[VoiceService] Transcribing compact utterance ({duration_seconds:.2f}s of audio)")
    else:
        print(
            f"[VoiceService] Transcribing {len(transcription_chunks)} chunks "
            f"({duration_seconds:.2f}s compact audio)"
        )

    transcripts: list[str] = []
    for index, transcription_audio in enumerate(transcription_chunks):
        if len(transcription_chunks) > 1:
            chunk_seconds = transcription_audio.shape[0] / TARGET_SAMPLE_RATE
            print(
                f"[VoiceService] Transcribing chunk {index + 1}/{len(transcription_chunks)} "
                f"({chunk_seconds:.2f}s)"
            )

        transcript = asr_model.recognize(transcription_audio, sample_rate=TARGET_SAMPLE_RATE).strip()
        if transcript:
            transcripts.append(transcript)

    return " ".join(transcripts).strip()


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
            "keep_alive": OLLAMA_REFINEMENT_KEEP_ALIVE,
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
        temp_path, upload_bytes = copy_upload_to_temp(file, suffix)
        
        print(f"[VoiceService] Processing audio file: {temp_path} ({upload_bytes} bytes)")
        wav = load_audio(temp_path)
        audio_stats = describe_audio(wav)
        print(
            "[VoiceService] Audio stats: "
            f"duration={audio_stats['duration_ms']:.0f}ms "
            f"peak={audio_stats['peak']:.4f} "
            f"rms={audio_stats['rms']:.4f}"
        )
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
        status_code = e.status_code if isinstance(e, HTTPException) else 500
        print(f"[VoiceService] Error processing audio: {e}")
        return JSONResponse(
            content={
                "text": "",
                "error": e.detail if isinstance(e, HTTPException) else str(e),
                "success": False
            },
            status_code=status_code
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
        temp_path, _upload_bytes = copy_upload_to_temp(file, suffix)
        
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
        status_code = e.status_code if isinstance(e, HTTPException) else 500
        return JSONResponse(
            content={
                "text": "",
                "error": e.detail if isinstance(e, HTTPException) else str(e),
                "success": False,
            },
            status_code=status_code
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

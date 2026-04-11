import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

import numpy as np
import soundfile as sf

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
import onnx_asr

app = FastAPI(title="Voice Flow Service")

VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 700
VAD_MIN_SPEECH_MS = 250
OLLAMA_CHAT_URL = os.environ.get("OLLAMA_CHAT_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_TIMEOUT_SECONDS = 20

asr_model = None
vad_model = None


def load_models():
    global asr_model, vad_model
    
    print("[VoiceService] Loading Parakeet TDT 0.6b-v3 ONNX...")
    asr_model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", quantization="int8")
    print("[VoiceService] Parakeet ONNX model loaded successfully")
    
    print("[VoiceService] Loading Silero VAD ONNX...")
    from silero_vad import load_silero_vad
    vad_model = load_silero_vad()
    print("[VoiceService] Silero VAD ONNX loaded successfully")


def has_speech(audio_path: str) -> tuple[bool, float]:
    """Check if audio contains speech using Silero VAD.
    
    Returns:
        tuple: (has_speech: bool, speech_duration_ms: float)
    """
    from silero_vad import get_speech_timestamps
    wav, sr = sf.read(audio_path, dtype="float32")
    if len(wav.shape) > 1:
        wav = wav.mean(axis=1)
    if sr != 16000:
        from scipy.signal import resample
        wav = resample(wav, int(len(wav) * 16000 / sr))
    wav = (wav * 32767).astype(np.int16)
    
    speech_timestamps = get_speech_timestamps(
        wav,
        vad_model,
        threshold=VAD_THRESHOLD,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS,
        min_speech_duration_ms=VAD_MIN_SPEECH_MS
    )
    
    if not speech_timestamps:
        return False, 0.0
    
    total_duration_samples = sum(t['end'] - t['start'] for t in speech_timestamps)
    sample_rate = 16000
    speech_duration_ms = (total_duration_samples / sample_rate) * 1000
    
    has_valid_speech = speech_duration_ms >= VAD_MIN_SPEECH_MS
    
    return has_valid_speech, speech_duration_ms


def transcribe_audio(audio_path: str) -> str:
    """Transcribe audio using Parakeet ONNX model."""
    global asr_model
    return asr_model.recognize(audio_path)


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
        
        has_speech_flag, speech_duration = has_speech(temp_path)
        
        if not has_speech_flag:
            return JSONResponse(
                content={
                    "text": "",
                    "error": f"No speech detected (duration: {speech_duration:.0f}ms, min: {VAD_MIN_SPEECH_MS}ms)",
                    "success": False
                }
            )
        
        print(f"[VoiceService] Speech detected: {speech_duration:.0f}ms, transcribing...")
        
        raw_text = transcribe_audio(temp_path)
        
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
        
        raw_text = transcribe_audio(temp_path)
        
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
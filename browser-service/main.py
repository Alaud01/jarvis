import asyncio
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from llm_wrapper import RobustChatOllama

BROWSER_SERVICE_PORT = int(os.environ.get("BROWSER_SERVICE_PORT", "8001"))
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
MAX_AGENT_STEPS = int(os.environ.get("BROWSER_MAX_STEPS", "50"))
DEFAULT_PLANNER_MODEL = os.environ.get("BROWSER_PLANNER_MODEL", "deepseek-v4-flash:cloud")
MAIN_MODEL_KEEP_ALIVE = os.environ.get("BROWSER_MODEL_KEEP_ALIVE", "2m")
PLANNER_MODEL_KEEP_ALIVE = os.environ.get("BROWSER_PLANNER_KEEP_ALIVE", "0")
AGENT_LLM_TIMEOUT = int(os.environ.get("BROWSER_LLM_TIMEOUT", "180"))
AGENT_STEP_TIMEOUT = max(int(os.environ.get("BROWSER_STEP_TIMEOUT", "300")), AGENT_LLM_TIMEOUT + 60)
BROWSER_VISION_MODE = os.environ.get("BROWSER_USE_VISION", "auto").strip().lower()
BROWSER_LLM_SCREENSHOT_WIDTH = int(os.environ.get("BROWSER_LLM_SCREENSHOT_WIDTH", "1024"))
BROWSER_LLM_SCREENSHOT_HEIGHT = int(os.environ.get("BROWSER_LLM_SCREENSHOT_HEIGHT", "768"))
BROWSER_WINDOW_WIDTH = BROWSER_LLM_SCREENSHOT_WIDTH if BROWSER_LLM_SCREENSHOT_WIDTH > 0 else 1024
BROWSER_WINDOW_HEIGHT = BROWSER_LLM_SCREENSHOT_HEIGHT if BROWSER_LLM_SCREENSHOT_HEIGHT > 0 else 768
VISION_MODEL_PATTERNS = (
    "kimi",
    "llava",
    "bakllava",
    "moondream",
    "minicpm-v",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen2.5vl",
    "gemma3",
    "gemma-3",
    "mistral-small3.2",
    "mistral-small-3.2",
)
BROWSER_AGENT_EXTEND_SYSTEM_MESSAGE = (
    "Follow the browser-use action schema exactly. If using the evaluate action, "
    "the JavaScript field is named code, not expression. Prefer built-in observe, "
    "click, input, send_keys, search_page, and find_elements actions before "
    "JavaScript evaluation, especially on interactive pages.\n\n"
    "Browser task planning rules:\n"
    "- Treat the user's browser_task as the complete objective for this run. Do not stop after merely opening a page if the task asks to interact, play, submit, purchase, log in, or otherwise continue.\n"
    "- For multi-step browser work, output plan_update early with concrete browser actions, such as navigate, wait for load, dismiss blockers, click the target control, fill fields/type keys, submit, inspect feedback, and call done only after the requested end state is reached.\n"
    "- If the task mentions a game or workflow, plan through the natural interaction sequence, not just the landing page. Example: for Wordle, open the page, click Play, close the tutorial, enter guesses, read tile feedback, continue until solved or attempts are exhausted, then report the result.\n"
    "- Use current_plan_item to advance the plan. Revise plan_update when the page state or action result shows the current plan is wrong.\n"
    "- DOM element indices and browser action results are authoritative for actions."
)
TRACE_PREFIX = "__JARVIS_BROWSER_TRACE__ "
TRACE_TEXT_LIMIT = 4000

active_agent_task: asyncio.Task | None = None
cancel_event = asyncio.Event()
_session_lock = asyncio.Lock()
_task_start_lock = asyncio.Lock()
_chromium_path: str | None = None
_persistent_session = None


def parse_keep_alive(value: str) -> str | int:
    normalized = value.strip()
    return 0 if normalized == "0" else normalized


class BrowserTaskRequest(BaseModel):
    task: str
    model: str
    provider: str = "ollama"
    api_key: str | None = None
    planner_model: str | None = None
    run_id: str | None = None


class BrowserTaskResponse(BaseModel):
    success: bool
    result: str | None = None
    error: str | None = None
    steps: int | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _truncate_text(value, limit: int = TRACE_TEXT_LIMIT) -> str | None:
    if value is None:
        return None

    text = str(value)
    if len(text) <= limit:
        return text

    return f"{text[:limit]}... [truncated {len(text) - limit} chars]"


def _emit_trace(event: dict) -> None:
    try:
        print(f"{TRACE_PREFIX}{json.dumps(event, ensure_ascii=False, default=str)}", flush=True)
    except Exception as e:
        print(f"[BrowserService] Failed to emit browser trace event: {e}", flush=True)


def _action_to_trace(action) -> dict:
    try:
        action_dump = action.model_dump(exclude_none=True, mode="json")
    except Exception:
        action_dump = {}

    if isinstance(action_dump, dict) and action_dump:
        if "input" in action_dump and len(action_dump) == 1:
            return {"toolName": "action", "input": action_dump.get("input") or {}}

        for key, value in action_dump.items():
            if isinstance(value, dict):
                return {"toolName": str(key), "input": value}
            return {"toolName": str(key), "input": {"value": value}}

    return {"toolName": type(action).__name__, "input": {}}


def _result_to_trace(result) -> dict:
    try:
        result_dump = result.model_dump(exclude_none=True, mode="json")
    except Exception:
        result_dump = {}

    trace: dict = {}
    if "is_done" in result_dump:
        trace["isDone"] = result_dump.get("is_done")
    if "success" in result_dump:
        trace["success"] = result_dump.get("success")
    if result_dump.get("error"):
        trace["error"] = _truncate_text(result_dump.get("error"))
    if result_dump.get("extracted_content"):
        trace["extractedContent"] = _truncate_text(result_dump.get("extracted_content"))
    if result_dump.get("long_term_memory"):
        trace["longTermMemory"] = _truncate_text(result_dump.get("long_term_memory"))
    if isinstance(result_dump.get("metadata"), dict):
        trace["metadata"] = result_dump.get("metadata")

    return trace


def _step_from_model_output(step_index: int, browser_state, model_output) -> dict:
    actions = []
    if getattr(model_output, "action", None):
        actions = [_action_to_trace(action) for action in model_output.action]

    return {
        "stepIndex": step_index,
        "timestamp": _now_iso(),
        "url": getattr(browser_state, "url", None),
        "pageTitle": getattr(browser_state, "title", None),
        "thinking": _truncate_text(getattr(model_output, "thinking", None)),
        "evaluationPreviousGoal": _truncate_text(getattr(model_output, "evaluation_previous_goal", None)),
        "memory": _truncate_text(getattr(model_output, "memory", None)),
        "nextGoal": _truncate_text(getattr(model_output, "next_goal", None)),
        "actions": actions,
        "planUpdate": getattr(model_output, "plan_update", None),
        "currentPlanItem": getattr(model_output, "current_plan_item", None),
    }


def _step_result_from_history_item(history_item) -> dict | None:
    if history_item is None:
        return None

    state = getattr(history_item, "state", None)
    metadata = getattr(history_item, "metadata", None)
    model_output = getattr(history_item, "model_output", None)
    step_number = getattr(metadata, "step_number", None)
    step_index = max(0, int(step_number) - 1) if step_number is not None else 0
    results = [_result_to_trace(result) for result in getattr(history_item, "result", [])]

    step = {
        "stepIndex": step_index,
        "timestamp": _now_iso(),
        "url": getattr(state, "url", None),
        "pageTitle": getattr(state, "title", None),
        "results": results,
    }

    if metadata is not None:
        step["durationMs"] = round(getattr(metadata, "duration_seconds", 0) * 1000)

    if model_output is not None:
        step.update({
            "thinking": _truncate_text(getattr(model_output, "thinking", None)),
            "evaluationPreviousGoal": _truncate_text(getattr(model_output, "evaluation_previous_goal", None)),
            "memory": _truncate_text(getattr(model_output, "memory", None)),
            "nextGoal": _truncate_text(getattr(model_output, "next_goal", None)),
            "actions": [_action_to_trace(action) for action in getattr(model_output, "action", [])],
            "planUpdate": getattr(model_output, "plan_update", None),
            "currentPlanItem": getattr(model_output, "current_plan_item", None),
        })

    return step


def find_chromium_executable() -> str | None:
    global _chromium_path
    if _chromium_path is not None:
        return _chromium_path

    env_path = os.environ.get("CHROMIUM_EXECUTABLE")
    if env_path and Path(env_path).is_file():
        _chromium_path = env_path
        return _chromium_path

    try:
        from playwright.sync_api import sync_playwright

        p = sync_playwright().start()
        path = p.chromium.executable_path
        p.stop()

        if path and Path(path).is_file():
            _chromium_path = path
            return _chromium_path
    except Exception:
        pass

    venv_dir = Path(__file__).resolve().parent / "venv"
    venv_python = venv_dir / "bin" / "python3"
    if venv_python.is_file():
        script = (
            "from playwright.sync_api import sync_playwright\n"
            "p = sync_playwright().start()\n"
            "print(p.chromium.executable_path)\n"
            "p.stop()\n"
        )
        try:
            result = subprocess.run(
                [str(venv_python), "-c", script],
                capture_output=True, text=True, timeout=15,
            )
            path = result.stdout.strip()
            if path and Path(path).is_file():
                _chromium_path = path
                return _chromium_path
        except Exception:
            pass

    candidates = [
        Path.home() / "Library" / "Caches" / "ms-playwright",
    ]
    for cache_dir in candidates:
        if not cache_dir.is_dir():
            continue
        for chromium_dir in sorted(cache_dir.glob("chromium-*"), reverse=True):
            exe = chromium_dir / "chrome-mac-arm64" / "Google Chrome for Testing.app" / "Contents" / "MacOS" / "Google Chrome for Testing"
            if exe.is_file():
                _chromium_path = str(exe)
                return _chromium_path
            exe_linux = chromium_dir / "chrome-linux" / "chrome"
            if exe_linux.is_file():
                _chromium_path = str(exe_linux)
                return _chromium_path

    return None


def create_browser_session():
    from browser_use.browser.session import BrowserSession

    browser_size = {"width": BROWSER_WINDOW_WIDTH, "height": BROWSER_WINDOW_HEIGHT}
    kwargs: dict = {
        "headless": False,
        "viewport": browser_size,
        "screen": browser_size,
        "window_size": browser_size,
        "device_scale_factor": 1,
        "args": [
            f"--window-size={BROWSER_WINDOW_WIDTH},{BROWSER_WINDOW_HEIGHT}",
            "--force-device-scale-factor=1",
        ],
    }

    chromium_path = find_chromium_executable()
    if chromium_path:
        print(f"[BrowserService] Using Chromium at: {chromium_path}")
        kwargs["executable_path"] = chromium_path
    else:
        print("[BrowserService] Warning: Could not find Chromium executable")

    return BrowserSession(**kwargs)


async def get_or_create_session():
    global _persistent_session
    async with _session_lock:
        if _persistent_session is not None:
            return _persistent_session
        _persistent_session = create_browser_session()
        return _persistent_session


async def stop_session():
    global _persistent_session
    if _persistent_session is not None:
        try:
            await _persistent_session.kill()
        except Exception:
            pass
        _persistent_session = None


async def _should_stop_callback() -> bool:
    return cancel_event.is_set()


def _call_or_value(value):
    return value() if callable(value) else value


def _recent_result_errors(result, count: int = 3) -> list[str]:
    try:
        errors_attr = getattr(result, "errors", None)
        errors = _call_or_value(errors_attr) if errors_attr is not None else []
        if not isinstance(errors, list):
            errors = list(errors or [])
        return [str(error) for error in errors if error is not None][-count:]
    except Exception as e:
        return [f"Could not read browser-use errors: {e}"]


def resolve_use_vision(model: str) -> bool:
    if BROWSER_VISION_MODE in ("1", "true", "yes", "on", "always"):
        return True
    if BROWSER_VISION_MODE in ("0", "false", "no", "off", "never"):
        return False

    normalized_model = model.lower()
    return any(pattern in normalized_model for pattern in VISION_MODEL_PATTERNS)


def get_llm_screenshot_size() -> tuple[int, int] | None:
    if BROWSER_LLM_SCREENSHOT_WIDTH <= 0 or BROWSER_LLM_SCREENSHOT_HEIGHT <= 0:
        return None

    return (BROWSER_LLM_SCREENSHOT_WIDTH, BROWSER_LLM_SCREENSHOT_HEIGHT)


async def run_browser_agent(
    task: str,
    model: str,
    provider: str = "ollama",
    api_key: str | None = None,
    planner_model: str | None = None,
    run_id: str | None = None,
) -> dict:
    global active_agent_task

    from browser_use.agent.service import Agent

    trace_run_id = run_id or str(uuid4())

    if provider == "ollama":
        from browser_use.llm.ollama.chat import ChatOllama
        print(f"[BrowserService] Creating ChatOllama with model={model}, host={OLLAMA_BASE_URL}, temperature=0")
        try:
            raw_llm = ChatOllama(
                model=model,
                host=OLLAMA_BASE_URL,
                timeout=300,
                ollama_options={"temperature": 0},
            )
            llm = RobustChatOllama(raw_llm, keep_alive=parse_keep_alive(MAIN_MODEL_KEEP_ALIVE))
            print(f"[BrowserService] RobustChatOllama wrapper created successfully for model={model}")
        except Exception as e:
            import traceback
            print(f"[BrowserService] Failed to create LLM for model={model}: {e}")
            print(f"[BrowserService] Traceback:\n{traceback.format_exc()}")
            raise
    else:
        raise ValueError(f"Unsupported provider for browser automation: {provider}")

    session = await get_or_create_session()

    # Validate the session is usable (CDP connected); if not, destroy and recreate
    if session._cdp_client_root is None:
        print("[BrowserService] Session CDP client is None, recreating session")
        await _reset_session()
        session = await get_or_create_session()

    # Resolve planner model: explicit param > env var > default
    effective_planner_model = planner_model or DEFAULT_PLANNER_MODEL
    planner_llm = None
    if effective_planner_model:
        try:
            from browser_use.llm.ollama.chat import ChatOllama
            print(f"[BrowserService] Creating planner ChatOllama with model={effective_planner_model}, temperature=0")
            raw_planner = ChatOllama(
                model=effective_planner_model,
                host=OLLAMA_BASE_URL,
                timeout=120,
                ollama_options={"temperature": 0},
            )
            planner_llm = RobustChatOllama(raw_planner, keep_alive=parse_keep_alive(PLANNER_MODEL_KEEP_ALIVE))
            print(f"[BrowserService] Using planner model: {effective_planner_model}")
        except Exception as e:
            print(f"[BrowserService] Warning: Could not initialize planner model '{effective_planner_model}': {e}")
            planner_llm = None

    use_vision = resolve_use_vision(model)
    llm_screenshot_size = get_llm_screenshot_size() if use_vision else None
    print(
        f"[BrowserService] Creating Agent: use_vision={use_vision}, "
        f"llm_screenshot_size={llm_screenshot_size}, model={model}, planner={effective_planner_model}"
    )

    _emit_trace({
        "runId": trace_run_id,
        "event": "started",
        "timestamp": _now_iso(),
        "status": "running",
        "instruction": task,
        "model": model,
        "provider": provider,
        "plannerModel": effective_planner_model,
        "useVision": use_vision,
        "llmScreenshotSize": llm_screenshot_size,
    })

    async def on_new_step(browser_state, model_output, n_steps: int):
        step = _step_from_model_output(max(0, n_steps - 1), browser_state, model_output)
        _emit_trace({
            "runId": trace_run_id,
            "event": "step",
            "timestamp": step["timestamp"],
            "status": "running",
            "instruction": task,
            "model": model,
            "provider": provider,
            "plannerModel": effective_planner_model,
            "useVision": use_vision,
            "llmScreenshotSize": llm_screenshot_size,
            "step": step,
        })

    async def on_step_end(agent):
        history = getattr(agent, "history", None)
        history_items = getattr(history, "history", None) if history is not None else None
        history_item = history_items[-1] if history_items else None
        step = _step_result_from_history_item(history_item)
        if step is None:
            return

        _emit_trace({
            "runId": trace_run_id,
            "event": "step_result",
            "timestamp": _now_iso(),
            "status": "running",
            "instruction": task,
            "model": model,
            "provider": provider,
            "plannerModel": effective_planner_model,
            "useVision": use_vision,
            "llmScreenshotSize": llm_screenshot_size,
            "step": step,
        })

    agent = Agent(
        task=task,
        llm=llm,
        planner_llm=planner_llm,
        use_vision=use_vision,
        browser_session=session,
        llm_screenshot_size=llm_screenshot_size,
        step_timeout=AGENT_STEP_TIMEOUT,
        llm_timeout=AGENT_LLM_TIMEOUT,
        extend_system_message=BROWSER_AGENT_EXTEND_SYSTEM_MESSAGE,
        register_new_step_callback=on_new_step,
        register_should_stop_callback=_should_stop_callback,
    )

    cancel_event.clear()

    active_agent_task = asyncio.current_task()
    started_at = time.perf_counter()

    try:
        result = await agent.run(max_steps=MAX_AGENT_STEPS, on_step_end=on_step_end)
    except asyncio.CancelledError:
        print("[BrowserService] Agent task was cancelled")
        _emit_trace({
            "runId": trace_run_id,
            "event": "cancelled",
            "timestamp": _now_iso(),
            "status": "cancelled",
            "instruction": task,
            "model": model,
            "provider": provider,
            "plannerModel": effective_planner_model,
            "error": "Task was cancelled.",
        })
        await _reset_session()
        raise
    except Exception as e:
        print(f"[BrowserService] Agent task failed with error: {e}")
        _emit_trace({
            "runId": trace_run_id,
            "event": "failed",
            "timestamp": _now_iso(),
            "status": "failed",
            "instruction": task,
            "model": model,
            "provider": provider,
            "plannerModel": effective_planner_model,
            "error": _truncate_text(e),
        })
        await _reset_session()
        raise
    finally:
        active_agent_task = None

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)

    final_result = _call_or_value(getattr(result, "final_result", None)) or ""

    steps = 0
    if hasattr(result, "history"):
        steps = len(result.history) if result.history else 0

    is_success = bool(_call_or_value(getattr(result, "is_successful", None)))

    error_text = ""
    if _call_or_value(getattr(result, "has_errors", None)):
        error_text = "\n".join(_recent_result_errors(result)) or ""

    if not is_success and not final_result and error_text:
        final_result = f"Task failed with errors:\n{error_text}"

    if not is_success:
        await _reset_session()

    print(
        f"[BrowserService] Task completed in {elapsed_ms}ms, "
        f"{steps} steps, success={is_success}, result length: {len(final_result)}"
    )

    _emit_trace({
        "runId": trace_run_id,
        "event": "completed" if is_success else "failed",
        "timestamp": _now_iso(),
        "status": "completed" if is_success else "failed",
        "instruction": task,
        "model": model,
        "provider": provider,
        "plannerModel": effective_planner_model,
        "summary": _truncate_text(final_result),
        "error": _truncate_text(error_text) if error_text else None,
        "steps": steps,
        "elapsedMs": elapsed_ms,
    })

    return {
        "success": is_success,
        "result": final_result,
        "steps": steps,
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[BrowserService] Starting up...")
    yield
    print("[BrowserService] Shutting down, closing browser session...")
    await stop_session()
    print("[BrowserService] Shut down")


app = FastAPI(title="Browser Automation Service", lifespan=lifespan)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.post("/cancel-browser-task")
async def cancel_browser_task():
    global active_agent_task

    cancel_event.set()

    if active_agent_task and not active_agent_task.done():
        active_agent_task.cancel()
        try:
            await active_agent_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[BrowserService] Browser task raised while cancelling: {e}")

    active_agent_task = None
    cancel_event.clear()

    await _reset_session()

    print("[BrowserService] Browser task cancelled via API")
    return {"status": "cancelled"}


async def _reset_session():
    global _persistent_session
    async with _session_lock:
        if _persistent_session is None:
            return

        try:
            await _persistent_session.kill()
        except Exception as e:
            print(f"[BrowserService] Error killing browser session: {e}")

        _persistent_session = None
        print("[BrowserService] Browser session destroyed; next task will create a fresh session")


@app.post("/browser-task", response_model=BrowserTaskResponse)
async def browser_task(request: BrowserTaskRequest):
    global active_agent_task

    task = request.task.strip()
    model = request.model.strip()
    provider = request.provider if request.provider else "ollama"
    api_key = request.api_key

    if not task:
        return JSONResponse(
            content=BrowserTaskResponse(
                success=False, error="Task description is required."
            ).model_dump(),
        )

    if not model:
        return JSONResponse(
            content=BrowserTaskResponse(
                success=False, error="Model name is required."
            ).model_dump(),
        )

    current_task = asyncio.current_task()
    async with _task_start_lock:
        if active_agent_task is not None and not active_agent_task.done():
            return JSONResponse(
                status_code=409,
                content=BrowserTaskResponse(
                    success=False,
                    error="Another browser task is already running. Wait for it to finish or cancel it before starting a new one.",
                ).model_dump(),
            )
        active_agent_task = current_task

    run_id = request.run_id or str(uuid4())

    print(f"[BrowserService] Running task with provider={provider}, model={model}, planner_model={request.planner_model}, run_id={run_id}: {task[:200]}")

    try:
        result = await run_browser_agent(task, model, provider, api_key, request.planner_model, run_id)
        print(f"[BrowserService] Task result: success={result.get('success')}, steps={result.get('steps')}, "
              f"result_len={len(result.get('result') or '')}, error={result.get('error', '')[:200]}")
        return JSONResponse(content=BrowserTaskResponse(**result).model_dump())
    except asyncio.CancelledError:
        print("[BrowserService] Task was cancelled")
        return JSONResponse(
            content=BrowserTaskResponse(
                success=False, error="Task was cancelled."
            ).model_dump(),
        )
    except Exception as e:
        import traceback
        error_message = str(e)
        error_type = type(e).__name__
        tb = traceback.format_exc()
        print(f"[BrowserService] Task failed: [{error_type}] {error_message}")
        print(f"[BrowserService] Traceback:\n{tb}")
        return JSONResponse(
            content=BrowserTaskResponse(
                success=False, error=f"[{error_type}] {error_message}"
            ).model_dump(),
        )
    finally:
        if active_agent_task is current_task:
            active_agent_task = None


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=BROWSER_SERVICE_PORT)

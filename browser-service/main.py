import asyncio
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from llm_wrapper import RobustChatOllama

BROWSER_SERVICE_PORT = int(os.environ.get("BROWSER_SERVICE_PORT", "8001"))
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
MAX_AGENT_STEPS = int(os.environ.get("BROWSER_MAX_STEPS", "50"))
DEFAULT_PLANNER_MODEL = os.environ.get("BROWSER_PLANNER_MODEL", "gemini-3-flash-preview:cloud")

active_agent_task: asyncio.Task | None = None
cancel_event = asyncio.Event()
_session_lock = asyncio.Lock()
_chromium_path: str | None = None
_persistent_session = None


class BrowserTaskRequest(BaseModel):
    task: str
    model: str
    provider: str = "ollama"
    api_key: str | None = None
    planner_model: str | None = None


class BrowserTaskResponse(BaseModel):
    success: bool
    result: str | None = None
    error: str | None = None
    steps: int | None = None


def find_chromium_executable() -> str | None:
    global _chromium_path
    if _chromium_path is not None:
        return _chromium_path

    env_path = os.environ.get("CHROMIUM_EXECUTABLE")
    if env_path and Path(env_path).is_file():
        _chromium_path = env_path
        return _chromium_path

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

    kwargs: dict = {"headless": False}

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


async def run_browser_agent(task: str, model: str, provider: str = "ollama", api_key: str | None = None, planner_model: str | None = None) -> dict:
    global active_agent_task

    from browser_use.agent.service import Agent

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
            llm = RobustChatOllama(raw_llm)
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
            planner_llm = RobustChatOllama(raw_planner)
            print(f"[BrowserService] Using planner model: {effective_planner_model}")
        except Exception as e:
            print(f"[BrowserService] Warning: Could not initialize planner model '{effective_planner_model}': {e}")
            planner_llm = None

    # Enable vision for models that support it (e.g., kimi)
    use_vision = "kimi" in model.lower()
    print(f"[BrowserService] Creating Agent: use_vision={use_vision}, model={model}, planner={effective_planner_model}")

    agent = Agent(
        task=task,
        llm=llm,
        planner_llm=planner_llm,
        use_vision=use_vision,
        browser_session=session,
        step_timeout=300,
        llm_timeout=300,
        register_should_stop_callback=_should_stop_callback,
    )

    cancel_event.clear()

    active_agent_task = asyncio.current_task()
    started_at = time.perf_counter()

    try:
        result = await agent.run(max_steps=MAX_AGENT_STEPS)
    except asyncio.CancelledError:
        print("[BrowserService] Agent task was cancelled")
        await _reset_session()
        raise
    except Exception as e:
        print(f"[BrowserService] Agent task failed with error: {e}")
        await _reset_session()
        raise
    finally:
        active_agent_task = None

    elapsed_ms = round((time.perf_counter() - started_at) * 1000)

    final_result = result.final_result() or ""

    steps = 0
    if hasattr(result, "history"):
        steps = len(result.history) if result.history else 0

    is_success = result.is_successful()

    error_text = ""
    if result.has_errors():
        error_text = "\n".join([str(e) for e in result.errors[-3:]]) or ""

    if not is_success and not final_result and error_text:
        final_result = f"Task failed with errors:\n{error_text}"

    if not is_success:
        await _reset_session()

    print(
        f"[BrowserService] Task completed in {elapsed_ms}ms, "
        f"{steps} steps, success={is_success}, result length: {len(final_result)}"
    )

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

    print(f"[BrowserService] Running task with provider={provider}, model={model}, planner_model={request.planner_model}: {task[:200]}")

    try:
        result = await run_browser_agent(task, model, provider, api_key, request.planner_model)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=BROWSER_SERVICE_PORT)
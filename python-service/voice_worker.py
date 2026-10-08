"""One admitted voice job at a time, with no unbounded executor backlog."""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import partial


class VoiceWorkerBusy(Exception):
    pass


class VoiceWorker:
    def __init__(self):
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-pipeline")
        self._admission = threading.Lock()

    async def run(self, function, *args):
        if not self._admission.acquire(blocking=False):
            raise VoiceWorkerBusy("Another dictation is still processing. Please try again shortly.")

        def work():
            try:
                return function(*args)
            finally:
                self._admission.release()

        try:
            future = asyncio.get_running_loop().run_in_executor(self._executor, work)
        except BaseException:
            self._admission.release()
            raise
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            # Native inference cannot be interrupted safely. Keep the uploaded
            # file alive and the admission slot occupied until the worker exits.
            try:
                await asyncio.shield(future)
            except Exception:
                pass
            raise

    async def close(self):
        await asyncio.to_thread(partial(self._executor.shutdown, wait=True, cancel_futures=True))

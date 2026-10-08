import asyncio
import json
import threading
import unittest
from unittest import mock

from fastapi import HTTPException
from fastapi.responses import JSONResponse

import main
from voice_worker import VoiceWorker, VoiceWorkerBusy


class VoiceWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = VoiceWorker()
        self.release = threading.Event()
        self.started = asyncio.Event()
        self.loop = asyncio.get_running_loop()

    async def asyncTearDown(self):
        self.release.set()
        await self.worker.close()

    def block(self, *_args):
        self.loop.call_soon_threadsafe(self.started.set)
        if not self.release.wait(5):
            raise RuntimeError("test worker was not released")
        return "transcribed"

    async def test_both_endpoints_leave_health_responsive_and_share_admission(self):
        with mock.patch.object(main, "voice_worker", self.worker), \
             mock.patch.object(main, "request_local_whisper_load", return_value=None), \
             mock.patch.object(main, "vad_model", object()), \
             mock.patch.object(main, "process_flow_sync", lambda *_args: JSONResponse({"text": self.block(), "success": True})), \
             mock.patch.object(main, "transcribe_only_sync", self.block):
            for endpoint in [main.process_flow, main.transcribe_only]:
                self.started.clear()
                self.release.clear()
                task = asyncio.create_task(endpoint(file=object()))
                await asyncio.wait_for(self.started.wait(), 1)
                self.assertFalse(task.done())
                health = await asyncio.wait_for(main.health_check(), 0.25)
                self.assertEqual(health["status"], "healthy")
                with self.assertRaises(HTTPException) as error:
                    await main.transcribe_only(file=object())
                self.assertEqual(error.exception.status_code, 429)
                self.release.set()
                result = await task
                if endpoint == main.process_flow:
                    payload = json.loads(result.body)
                    self.assertEqual(payload["text"], "transcribed")
                    self.assertIn("service_total_ms", payload["diagnostics"]["timings_ms"])
                else:
                    self.assertEqual(result, "transcribed")

    async def test_cold_start_wait_admits_only_one_request_across_both_endpoints(self):
        for first_endpoint, second_endpoint in [
            (main.process_flow, main.transcribe_only),
            (main.transcribe_only, main.process_flow),
        ]:
            release_load = asyncio.Event()

            async def loading():
                await release_load.wait()

            preload = asyncio.create_task(loading())
            with mock.patch.object(main, "voice_worker", self.worker), \
                 mock.patch.object(main, "local_whisper_active_requests", 0), \
                 mock.patch.object(main, "request_local_whisper_load", return_value=preload), \
                 mock.patch.object(main, "process_flow_sync", lambda *_args: JSONResponse({"success": True})), \
                 mock.patch.object(main, "transcribe_only_sync", lambda *_args: "transcribed"):
                request = asyncio.create_task(first_endpoint(file=object()))
                await asyncio.sleep(0)
                try:
                    self.assertEqual(main.local_whisper_active_requests, 1)
                    with self.assertRaises(HTTPException) as error:
                        await asyncio.wait_for(second_endpoint(file=object()), 0.05)
                    self.assertEqual(error.exception.status_code, 429)
                    self.assertEqual(error.exception.headers, {"Retry-After": "1"})
                    self.assertEqual(main.local_whisper_active_requests, 1)
                finally:
                    release_load.set()
                    await request
                self.assertEqual(main.local_whisper_active_requests, 0)
                await second_endpoint(file=object())
                self.assertEqual(main.local_whisper_active_requests, 0)

    async def test_process_flow_reports_model_wait_separately_from_worker_processing(self):
        release_load = asyncio.Event()

        async def loading():
            await release_load.wait()

        preload = asyncio.create_task(loading())

        def process(_file, _context, timings):
            self.assertIn("model_wait_ms", timings)
            self.assertIn("worker_dispatch_ms", timings)
            timings["total_ms"] = 3
            return JSONResponse({"text": "Hello.", "success": True, "diagnostics": {"timings_ms": timings}})

        with mock.patch.object(main, "voice_worker", self.worker), \
             mock.patch.object(main, "request_local_whisper_load", return_value=preload), \
             mock.patch.object(main, "process_flow_sync", process), \
             self.assertLogs("VoiceService", level="WARNING") as logs:
            request = asyncio.create_task(main.process_flow(object(), None, "test-wait"))
            await asyncio.sleep(0.04)
            self.assertFalse(request.done())
            release_load.set()
            payload = json.loads((await request).body)
        timings = payload["diagnostics"]["timings_ms"]
        self.assertGreaterEqual(timings["model_wait_ms"], 30)
        self.assertGreaterEqual(timings["service_total_ms"], timings["model_wait_ms"])
        self.assertEqual(timings["total_ms"], 3)
        self.assertEqual(payload["diagnostics"]["request_id"], "test-wait")
        self.assertIn("[VoiceTiming test-wait] service", logs.output[0])
        self.assertIn("pipeline_total_ms=3ms", logs.output[0])

    async def test_cancel_does_not_admit_another_job_while_native_work_is_running(self):
        task = asyncio.create_task(self.worker.run(self.block))
        await asyncio.wait_for(self.started.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        with self.assertRaises(VoiceWorkerBusy):
            await self.worker.run(lambda: "unsafe overlap")
        self.assertFalse(task.done())
        self.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(await self.worker.run(lambda: "next"), "next")

    async def test_pipeline_failure_releases_admission(self):
        def fail():
            raise RuntimeError("inference failed")

        with self.assertRaisesRegex(RuntimeError, "inference failed"):
            await self.worker.run(fail)
        self.assertEqual(await self.worker.run(lambda: "next"), "next")


class WhisperStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_preload_and_inference_share_thread_while_health_stays_responsive(self):
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        threads = []

        def preload():
            threads.append(threading.get_ident())
            loop.call_soon_threadsafe(started.set)
            if not release.wait(5):
                raise RuntimeError("preload was not released")

        def inference(_file):
            threads.append(threading.get_ident())
            return "transcribed"

        with mock.patch.object(main, "load_models"), \
             mock.patch.object(main, "load_local_whisper_model", preload), \
             mock.patch.object(main, "vad_model", object()), \
             mock.patch.object(main, "transcribe_only_sync", inference):
            async with main.lifespan(main.app):
                await asyncio.wait_for(started.wait(), 1)
                request = asyncio.create_task(main.transcribe_only(object()))
                try:
                    health = await asyncio.wait_for(main.health_check(), 0.25)
                    self.assertEqual(health["transcription_provider"], "local-whisper")
                    await asyncio.sleep(0)
                    self.assertFalse(request.done())
                finally:
                    release.set()
                self.assertEqual(await request, "transcribed")
                self.assertEqual(len(threads), 2)
                self.assertEqual(threads[0], threads[1])

    async def test_preload_timeout_does_not_cancel_native_loading(self):
        started = asyncio.Event()
        release = threading.Event()
        finished = threading.Event()
        loop = asyncio.get_running_loop()

        def preload():
            loop.call_soon_threadsafe(started.set)
            release.wait(5)
            finished.set()

        with mock.patch.object(main, "load_models"), \
             mock.patch.object(main, "load_local_whisper_model", preload), \
             mock.patch.object(main, "LOCAL_WHISPER_COLD_START_BUDGET_SECONDS", 0.02):
            async with main.lifespan(main.app):
                await asyncio.wait_for(started.wait(), 1)
                try:
                    with self.assertRaises(HTTPException) as error:
                        await main.transcribe_only(object())
                    self.assertEqual(error.exception.status_code, 503)
                    self.assertFalse(main.whisper_preload_task.done())
                    self.assertFalse(finished.is_set())
                finally:
                    release.set()
            self.assertTrue(finished.is_set())


class WhisperIdleTests(unittest.TestCase):
    def setUp(self):
        from types import ModuleType, SimpleNamespace
        self.resident = object()
        self.holder = SimpleNamespace(model=self.resident, model_path=main.LOCAL_WHISPER_MODEL)
        self.mx = mock.Mock()
        mlx = ModuleType("mlx")
        mlx.core = self.mx
        transcribe = ModuleType("mlx_whisper.transcribe")
        transcribe.ModelHolder = self.holder
        self.modules = {"mlx": mlx, "mlx.core": self.mx, "mlx_whisper.transcribe": transcribe}

    def test_expired_idle_model_releases_both_weight_references_and_gpu_cache(self):
        ready = threading.Event()
        ready.set()
        with mock.patch.dict("sys.modules", self.modules), \
             mock.patch.object(main, "local_whisper_model", self.resident), \
             mock.patch.object(main, "local_whisper_last_used_at", 400.0), \
             mock.patch.object(main, "local_whisper_loading", False), \
             mock.patch.object(main, "local_whisper_active_requests", 0), \
             mock.patch.object(main, "local_whisper_ready", ready), \
             mock.patch.object(main.time, "perf_counter", return_value=1000.0), \
             mock.patch.object(main, "LOCAL_WHISPER_IDLE_UNLOAD_SECONDS", 600):
            self.assertTrue(main.unload_local_whisper_model("idle timeout"))
            self.assertIsNone(main.local_whisper_model)
            self.assertIsNone(self.holder.model)
            self.assertIsNone(self.holder.model_path)
            self.assertIsNone(main.local_whisper_last_used_at)
            self.assertFalse(ready.is_set())
        self.mx.synchronize.assert_called_once()
        self.mx.clear_cache.assert_called_once()

    def test_recent_activity_loading_and_active_requests_prevent_unloading(self):
        with mock.patch.dict("sys.modules", self.modules), \
             mock.patch.object(main, "local_whisper_model", self.resident), \
             mock.patch.object(main.time, "perf_counter", return_value=1000.0), \
             mock.patch.object(main, "LOCAL_WHISPER_IDLE_UNLOAD_SECONDS", 600):
            for last_used, loading, active in [(401.0, False, 0), (400.0, True, 0), (400.0, False, 1)]:
                with self.subTest(last_used=last_used, loading=loading, active=active), \
                     mock.patch.object(main, "local_whisper_last_used_at", last_used), \
                     mock.patch.object(main, "local_whisper_loading", loading), \
                     mock.patch.object(main, "local_whisper_active_requests", active):
                    self.assertFalse(main.unload_local_whisper_model("idle timeout"))
                    self.assertIs(main.local_whisper_model, self.resident)
        self.mx.clear_cache.assert_not_called()

    def test_default_idle_timeout_is_ten_minutes(self):
        self.assertEqual(main.LOCAL_WHISPER_IDLE_UNLOAD_SECONDS, 600.0)


class WhisperReloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_unload_shortcut_reload_and_inference_share_worker(self):
        from types import ModuleType, SimpleNamespace
        loop = asyncio.get_running_loop()
        unloaded = asyncio.Event()
        inference_started = asyncio.Event()
        release = threading.Event()
        calls = []
        holder = SimpleNamespace(model=None, model_path=None)
        mx = mock.Mock()
        mlx = ModuleType("mlx")
        mlx.core = mx
        transcribe = ModuleType("mlx_whisper.transcribe")
        transcribe.ModelHolder = holder

        def load():
            calls.append(("load", threading.get_ident()))
            main.local_whisper_model = holder.model = object()
            holder.model_path = main.LOCAL_WHISPER_MODEL
            main.local_whisper_ready.set()
            main.touch_local_whisper_model()

        def offloaded():
            calls.append(("unload", threading.get_ident()))
            loop.call_soon_threadsafe(unloaded.set)

        def inference(_file):
            calls.append(("inference", threading.get_ident()))
            self.assertIsNotNone(main.get_ready_local_whisper_model())
            loop.call_soon_threadsafe(inference_started.set)
            if not release.wait(5):
                raise RuntimeError("inference was not released")
            return "transcribed"

        mx.clear_cache.side_effect = offloaded
        with mock.patch.dict("sys.modules", {"mlx": mlx, "mlx.core": mx, "mlx_whisper.transcribe": transcribe}), \
             mock.patch.object(main, "load_models"), \
             mock.patch.object(main, "load_local_whisper_model", load), \
             mock.patch.object(main, "local_whisper_model", None), \
             mock.patch.object(main, "local_whisper_ready", threading.Event()), \
             mock.patch.object(main, "local_whisper_last_used_at", None), \
             mock.patch.object(main, "local_whisper_loading", False), \
             mock.patch.object(main, "vad_model", object()), \
             mock.patch.object(main, "LOCAL_WHISPER_IDLE_UNLOAD_SECONDS", 0.06), \
             mock.patch.object(main, "transcribe_only_sync", inference):
            async with main.lifespan(main.app):
                await asyncio.shield(main.whisper_preload_task)
                # A warm shortcut refreshes the idle deadline without reloading.
                await main.warmup_voice_model()
                self.assertEqual(len(calls), 1)
                await asyncio.wait_for(unloaded.wait(), 1)
                self.assertIsNone(main.local_whisper_model)
                # Repeated recording requests share one load.
                await main.warmup_voice_model()
                first_reload = main.whisper_preload_task
                await main.warmup_voice_model()
                self.assertIs(first_reload, main.whisper_preload_task)
                await asyncio.shield(first_reload)
                request = asyncio.create_task(main.transcribe_only(object()))
                try:
                    await asyncio.wait_for(inference_started.wait(), 1)
                    await asyncio.sleep(0.1)
                    self.assertIsNotNone(main.local_whisper_model)
                    health = await asyncio.wait_for(main.health_check(), 0.25)
                    self.assertEqual(health["local_whisper_active_requests"], 1)
                finally:
                    release.set()
                self.assertEqual(await request, "transcribed")
                self.assertEqual([operation for operation, _ in calls], ["load", "unload", "load", "inference"])
                self.assertEqual(len({thread for _, thread in calls}), 1)
                self.assertEqual(main.local_whisper_active_requests, 0)

    async def test_shortcut_during_offload_waits_then_reloads(self):
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        worker = VoiceWorker()
        old_model = object()
        new_model = object()

        def unload():
            loop.call_soon_threadsafe(started.set)
            release.wait(5)
            main.local_whisper_model = None

        def load():
            main.local_whisper_model = new_model

        with mock.patch.object(main, "voice_worker", worker), \
             mock.patch.object(main, "local_whisper_model", old_model), \
             mock.patch.object(main, "load_local_whisper_model", load), \
             mock.patch.object(main, "whisper_preload_task", None), \
             mock.patch.object(main, "whisper_unload_task", None):
            try:
                main.whisper_unload_task = asyncio.create_task(worker.run(unload))
                await asyncio.wait_for(started.wait(), 1)
                response = await asyncio.wait_for(main.warmup_voice_model(), 0.25)
                self.assertTrue(response["loading"])
                self.assertFalse(main.whisper_preload_task.done())
                release.set()
                await asyncio.wait_for(asyncio.shield(main.whisper_preload_task), 1)
                self.assertIs(main.local_whisper_model, new_model)
            finally:
                release.set()
                await worker.close()

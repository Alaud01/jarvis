import io
import importlib
import json
import os
import ssl
import tempfile
import unittest
from unittest import mock
from urllib import error as urllib_error

from fastapi import HTTPException

import main


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.payload


class VoiceContextTests(unittest.TestCase):
    def test_local_parakeet_defaults_to_huggingface_110m_with_openrouter_fallback(self):
        try:
            with mock.patch.dict(os.environ, {}, clear=True):
                reloaded_main = importlib.reload(main)
                self.assertTrue(reloaded_main.LOCAL_PARAKEET_ENABLED)
                self.assertEqual(reloaded_main.LOCAL_PARAKEET_MODEL, "nvidia/parakeet-tdt_ctc-110m")
                self.assertEqual(reloaded_main.LOCAL_PARAKEET_DEVICE, "mps")
                self.assertTrue(reloaded_main.LOCAL_PARAKEET_PRELOAD_ENABLED)
                self.assertEqual(reloaded_main.OPENROUTER_TRANSCRIPTION_MODEL, "nvidia/parakeet-tdt-0.6b-v3")
                self.assertEqual(reloaded_main.LOCAL_PARAKEET_COLD_START_BUDGET_SECONDS, 90.0)
                self.assertFalse(reloaded_main.LOCAL_PARAKEET_TIMEOUT_FALLBACK_ENABLED)
                self.assertEqual(reloaded_main.LOCAL_PARAKEET_IDLE_UNLOAD_SECONDS, 600.0)
        finally:
            importlib.reload(main)

    def test_missing_context_uses_generic_defaults(self):
        context = main.parse_voice_context(None)

        self.assertEqual(context.destination, "generic")
        self.assertIsNone(context.field)

    def test_context_limits_are_validated(self):
        raw_context = json.dumps(
            {
                "destination": "chat",
                "field": {"textBeforeCursor": "x" * 1001},
            }
        )

        with self.assertRaises(HTTPException):
            main.parse_voice_context(raw_context)

    def test_technical_app_detection_uses_app_identity(self):
        cursor = main.VoiceContext(
            app=main.VoiceAppContext(name="Cursor", bundleId="com.todesktop.230313mzl4w4u92", pid=1)
        )
        mail = main.VoiceContext(
            app=main.VoiceAppContext(name="Mail", bundleId="com.apple.mail", pid=2)
        )
        self.assertTrue(main.is_technical_app(cursor))
        self.assertFalse(main.is_technical_app(mail))
        self.assertEqual(main.refinement_mode_for_context(cursor), "Cursor")
        self.assertEqual(main.refinement_mode_for_context(mail), "Mail")

    def test_technical_prompt_disables_filler_and_style_rewrites(self):
        messages = main.build_refinement_messages(
            "git status no make that git diff",
            main.VoiceContext(
                app=main.VoiceAppContext(name="Terminal", bundleId="com.apple.Terminal", pid=1)
            ),
        )

        self.assertIn("do not remove fillers or apply stylistic formatting", messages[0]["content"])

    def test_dictionary_context_limits_are_validated(self):
        raw_context = json.dumps(
            {"dictionary": [{"preferred": "x" * 121, "aliases": []}]}
        )
        with self.assertRaises(HTTPException):
            main.parse_voice_context(raw_context)


class RefinementTests(unittest.TestCase):
    def test_prompt_requests_explicit_self_corrections_and_context(self):
        context = main.VoiceContext(
            app=main.VoiceAppContext(name="Mail", bundleId="com.apple.mail", pid=123),
            field=main.VoiceFieldContext(textBeforeCursor="Hi Sam,"),
            accessibilityStatus="captured",
        )

        messages = main.build_refinement_messages("Meet at two, actually three.", context)

        self.assertIn("'actually'", messages[0]["content"])
        self.assertIn("'or'", messages[0]["content"])
        self.assertIn("'no, make that'", messages[0]["content"])
        self.assertIn("'scratch that'", messages[0]["content"])
        self.assertIn("very similar in meaning or wording", messages[0]["content"])
        self.assertIn("drop the earlier abandoned phrasing", messages[0]["content"])
        payload = json.loads(messages[1]["content"])
        self.assertNotIn("destination", payload)
        self.assertEqual(payload["app_name"], "Mail")
        self.assertNotIn("text_before_cursor", payload)
        self.assertEqual(payload["disambiguation_hints"]["text_before_cursor"], "Hi Sam,")
        self.assertEqual(payload["raw_transcript"], "Meet at two, actually three.")
        self.assertIn("edit of raw_transcript only", messages[0]["content"])
        self.assertIn("never copy, quote, continue, summarize, or splice tokens from disambiguation_hints", messages[0]["content"])

    def test_prompt_expects_speech_grammar_and_recognition_errors(self):
        messages = main.build_refinement_messages(
            "She go there no she went there",
            main.VoiceContext(destination="chat"),
        )

        prompt = messages[0]["content"]
        self.assertIn("natural speech errors and recognition errors", prompt)
        self.assertIn("misspellings", prompt)
        self.assertIn("false starts", prompt)
        self.assertIn("mid-sentence corrections", prompt)
        self.assertIn("preserve the transcript rather than guessing", prompt)
        self.assertIn("do not grammatically rewrite commands or code", prompt)
        self.assertNotIn("missing words", prompt)
        self.assertIn("Do not add inferred ideas or missing content", prompt)
        self.assertIn("Make the smallest local edit", prompt)

    def test_prompt_requires_appropriate_number_normalization(self):
        messages = main.build_refinement_messages(
            "version two point one costs twenty five dollars",
            main.VoiceContext(
                app=main.VoiceAppContext(name="Terminal", bundleId="com.apple.Terminal", pid=1)
            ),
        )

        prompt = messages[0]["content"]
        self.assertIn("Normalize spoken numbers into digits", prompt)
        self.assertIn("required speech-to-text correction", prompt)
        self.assertIn("also applies in technical literal mode", prompt)
        self.assertIn("'twenty five percent' becomes '25%'", prompt)
        self.assertIn("'version two point one' becomes 'version 2.1'", prompt)
        self.assertIn("Record number normalization as a formatting edit", prompt)

    def test_prompt_encourages_line_paragraph_and_list_formatting(self):
        messages = main.build_refinement_messages(
            "Tasks new line first update dependencies next item run the tests",
            main.VoiceContext(
                app=main.VoiceAppContext(name="Mail", bundleId="com.apple.mail", pid=1)
            ),
        )

        prompt = messages[0]["content"]
        self.assertIn("Infer and apply the speaker's intended document structure proactively", prompt)
        self.assertIn("The speaker must not need to say formatting commands", prompt)
        self.assertIn("never says 'bullet point' or 'new line'", prompt)
        self.assertIn("Preserve and improve clearly intended structure", prompt)
        self.assertIn("'new line'", prompt)
        self.assertIn("'new paragraph'", prompt)
        self.assertIn("'bullet point'", prompt)
        self.assertIn("optional explicit overrides", prompt)
        self.assertIn("put one item per line", prompt)
        self.assertIn("Use a numbered list when order, sequence, or ranking matters", prompt)
        self.assertIn("otherwise use bullet points", prompt)
        self.assertIn("Do not turn ordinary continuous prose into a list", prompt)
        self.assertIn("Record added line breaks, paragraphs, or lists as a formatting edit", prompt)

    def test_technical_prompt_preserves_explicit_layout_cues(self):
        messages = main.build_refinement_messages(
            "commands new line git status new line git diff",
            main.VoiceContext(
                app=main.VoiceAppContext(name="Terminal", bundleId="com.apple.Terminal", pid=1)
            ),
        )

        prompt = messages[0]["content"]
        self.assertIn("In technical literal mode, preserve explicitly dictated line breaks and infer obvious", prompt)
        self.assertIn("do not reformat commands or code based only on stylistic preference", prompt)

    def test_prompt_locks_dictionary_and_boosted_vocabulary_terms(self):
        context = main.VoiceContext(
            dictionary=[main.VoiceDictionaryEntry(preferred="OpenAI", aliases=["open ai"])],
            vocabulary=[main.VoiceVocabularyEntry(text="PyTorch", pinned=True)],
        )

        messages = main.build_refinement_messages("Use OpenAI with PyTorch", context)
        prompt = messages[0]["content"]
        payload = json.loads(messages[1]["content"])

        self.assertIn("personal_dictionary preferred values are authoritative locked text", prompt)
        self.assertIn("Never grammar-correct, normalize, split", prompt)
        self.assertIn("vocabulary values are boosted recognition terms", prompt)
        self.assertIn("must never cause an unrelated word to be replaced", prompt)
        self.assertEqual(payload["personal_dictionary"][0]["preferred"], "OpenAI")
        self.assertEqual(payload["vocabulary"][0]["text"], "PyTorch")

    def test_valid_structured_output_is_parsed(self):
        content = json.dumps(
            {
                "text": "Meet at three.",
                "applied_edits": ["self_correction", "punctuation", "punctuation"],
            }
        )

        result = main.parse_refinement_output(content, "Meet at two actually three", "chat")

        self.assertEqual(result.text, "Meet at three.")
        self.assertEqual(result.refinement_mode, "chat")
        self.assertEqual(result.applied_edits, ["self_correction", "punctuation"])

    def test_malformed_structured_output_falls_back_to_raw(self):
        result = main.parse_refinement_output("not json", "raw transcript", "document")

        self.assertEqual(result.text, "raw transcript")
        self.assertEqual(result.refinement_mode, "raw_fallback")
        self.assertEqual(result.applied_edits, [])

    def test_empty_structured_text_falls_back_to_raw(self):
        content = json.dumps({"text": " ", "applied_edits": []})

        result = main.parse_refinement_output(content, "raw transcript", "generic")

        self.assertEqual(result.text, "raw transcript")
        self.assertEqual(result.refinement_mode, "raw_fallback")

    def test_dictionary_is_included_in_prompt(self):
        context = main.VoiceContext(
            dictionary=[main.VoiceDictionaryEntry(preferred="Jarvis", aliases=["jar viss"])]
        )
        messages = main.build_refinement_messages("Ask Jarvis", context)
        payload = json.loads(messages[1]["content"])
        self.assertEqual(payload["personal_dictionary"][0]["preferred"], "Jarvis")
        self.assertIn("preserve every occurrence exactly", messages[0]["content"])

    def test_dictionary_replacement_preserves_exact_casing_and_boundaries(self):
        entries = [main.VoiceDictionaryEntry(id="rule-openai", preferred="OpenAI", aliases=["open ai"])]
        text, applied_rules = main.apply_dictionary_entries("open ai and open air", entries)
        self.assertEqual(text, "OpenAI and open air")
        self.assertEqual(len(applied_rules), 1)
        self.assertEqual(applied_rules[0].ruleId, "rule-openai")
        self.assertEqual(applied_rules[0].start, 0)
        self.assertEqual(applied_rules[0].end, len("OpenAI"))

    def test_preferred_term_without_alias_is_vocabulary_not_replacement(self):
        entries = [main.VoiceDictionaryEntry(preferred="Jarvis", aliases=[])]
        text, applied_rules = main.apply_dictionary_entries("ask jarvis", entries)
        self.assertEqual(text, "ask jarvis")
        self.assertEqual(applied_rules, [])

    def test_dictionary_prefers_longest_alias(self):
        entries = [
            main.VoiceDictionaryEntry(preferred="Flow", aliases=["wispr"]),
            main.VoiceDictionaryEntry(preferred="Wispr Flow", aliases=["wispr flow"]),
        ]
        text, applied = main.apply_dictionary_entries("use wispr flow", entries)
        self.assertEqual(text, "use Wispr Flow")
        self.assertEqual(len(applied), 1)

    def test_dictionary_edit_is_reported_on_refinement_fallback(self):
        context = main.VoiceContext(
            dictionary=[main.VoiceDictionaryEntry(preferred="Jarvis", aliases=["jar viss"])]
        )
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", side_effect=urllib_error.URLError("offline")):
                result = main.refine_transcript("ask jar viss", context)
        self.assertEqual(result.text, "ask Jarvis")
        self.assertEqual(result.applied_edits, ["dictionary"])

    def test_rule_fallback_resolves_question_restart(self):
        raw_text = (
            "I'll be consistent with leetcode questions for a few days, but then I'll have a long gap. "
            "I don't know if it's because I'm losing motivation or what, but how do I make it so that I stay "
            "Actually, how can I stay consistent?"
        )

        result = main.build_fallback_refinement(raw_text, main.VoiceContext())

        self.assertEqual(
            result.text,
            "I'll be consistent with leetcode questions for a few days, but then I'll have a long gap. "
            "I don't know if it's because I'm losing motivation or what, but how can I stay consistent?",
        )
        self.assertEqual(result.refinement_mode, "rule_fallback")
        self.assertEqual(result.applied_edits, ["self_correction"])

    def test_rule_fallback_leaves_ambiguous_actually_unchanged(self):
        raw_text = "I actually enjoy solving these questions."

        result = main.build_fallback_refinement(raw_text, main.VoiceContext())

        self.assertEqual(result.text, raw_text)
        self.assertEqual(result.applied_edits, [])

    def test_timeout_uses_rule_fallback_instead_of_raw_transcript(self):
        raw_text = "How do I stay motivated? Actually, how can I stay consistent?"
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", side_effect=TimeoutError("timed out")):
                result = main.refine_transcript(raw_text, main.VoiceContext())

        self.assertEqual(result.text, "How can I stay consistent?")
        self.assertEqual(result.refinement_mode, "rule_fallback")
        self.assertEqual(result.applied_edits, ["self_correction"])

    def test_openrouter_refinement_uses_gpt_oss_with_latency_sort_and_throughput_floor(self):
        response = FakeResponse(
            {
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "type": "function",
                                    "function": {
                                        "name": "submit_refinement",
                                        "arguments": json.dumps(
                                            {
                                                "text": "Hello, world.",
                                                "applied_edits": ["punctuation"],
                                            }
                                        ),
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", return_value=response) as urlopen:
                result = main.refine_transcript("hello world", main.VoiceContext(destination="chat"))

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))

        self.assertEqual(result.text, "Hello, world.")
        self.assertEqual(payload["model"], "openai/gpt-oss-120b")
        self.assertEqual(payload["reasoning"], {"effort": "low"})
        self.assertEqual(payload["provider"]["sort"], "latency")
        self.assertEqual(
            payload["provider"]["preferred_min_throughput"],
            {"p50": main.OPENROUTER_REFINEMENT_MIN_THROUGHPUT},
        )
        self.assertGreaterEqual(main.OPENROUTER_REFINEMENT_MIN_THROUGHPUT, 200.0)
        self.assertTrue(payload["provider"]["require_parameters"])
        self.assertNotIn("response_format", payload)
        self.assertEqual(payload["tools"][0]["function"]["name"], "submit_refinement")
        self.assertEqual(payload["tools"][0]["function"]["parameters"], main.REFINEMENT_OUTPUT_SCHEMA)
        self.assertNotIn("tool_choice", payload)

    def test_disambiguation_hints_truncate_surrounding_field_text(self):
        long_before = "A" * 200 + "END"
        long_after = "START" + "B" * 200
        context = main.VoiceContext(
            app=main.VoiceAppContext(name="Cursor", bundleId="com.todesktop.230313mzl4w4u92", pid=1),
            field=main.VoiceFieldContext(
                textBeforeCursor=long_before,
                selectedText="sel" * 40,
                textAfterCursor=long_after,
            ),
        )

        with mock.patch.object(main, "REFINEMENT_DISAMBIGUATION_HINT_CHARS", 80):
            payload = json.loads(main.build_refinement_messages("hello", context)[1]["content"])

        hints = payload["disambiguation_hints"]
        self.assertEqual(len(hints["text_before_cursor"]), 80)
        self.assertTrue(hints["text_before_cursor"].endswith("END"))
        self.assertEqual(len(hints["text_after_cursor"]), 80)
        self.assertTrue(hints["text_after_cursor"].startswith("START"))
        self.assertEqual(len(hints["selected_text"]), 80)
        self.assertNotIn("text_before_cursor", payload)


class PausePreservingChunkTests(unittest.TestCase):
    def test_internal_pause_is_preserved_exactly(self):
        wav = main.np.linspace(-0.5, 0.5, 30000, dtype=main.np.float32)
        speech_segments = [(5000, 6000), (20000, 21000)]

        chunks, duration_seconds = main.iter_transcription_chunks(wav, speech_segments)

        self.assertEqual(len(chunks), 1)
        main.np.testing.assert_array_equal(chunks[0], wav[1000:25000])
        self.assertAlmostEqual(duration_seconds, 24000 / main.TARGET_SAMPLE_RATE)

    def test_long_pause_splits_at_vad_boundary_instead_of_being_uploaded(self):
        wav = main.np.zeros(32000, dtype=main.np.float32)
        speech_segments = [(5000, 6000), (25000, 26000)]

        with mock.patch.object(main, "MAX_TRANSCRIPTION_CHUNK_SAMPLES", 12000):
            ranges = main.build_pause_preserving_ranges(speech_segments, wav.shape[0])
            chunks, _duration_seconds = main.iter_transcription_chunks(wav, speech_segments)

        self.assertEqual(ranges, [(1000, 10000), (21000, 30000)])
        self.assertEqual([chunk.shape[0] for chunk in chunks], [9000, 9000])

    def test_long_continuous_speech_is_hard_split_to_bound_requests(self):
        wav = main.np.zeros(5000, dtype=main.np.float32)

        with mock.patch.object(main, "MAX_TRANSCRIPTION_CHUNK_SAMPLES", 1000):
            ranges = main.build_pause_preserving_ranges([(100, 4900)], wav.shape[0])

        self.assertEqual(ranges, [(0, 1000), (1000, 2000), (2000, 3000), (3000, 4000), (4000, 5000)])


class OpenRouterTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.wav = main.np.zeros(1600, dtype=main.np.float32)

    def test_transient_ssl_failure_is_retried(self):
        responses = [
            ssl.SSLError("ssl/tls alert bad record mac"),
            FakeResponse({"text": "recovered transcript"}),
        ]

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", side_effect=responses) as urlopen:
                with mock.patch.object(main.time, "sleep") as sleep:
                    transcript = main.transcribe_chunk_with_openrouter(self.wav)

        self.assertEqual(transcript, "recovered transcript")
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(main.OPENROUTER_RETRY_BASE_DELAY_SECONDS)

    def test_exhausted_ssl_failures_return_bad_gateway(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", side_effect=ssl.SSLError("bad record mac")):
                with mock.patch.object(main.time, "sleep"):
                    with self.assertRaises(HTTPException) as raised:
                        main.transcribe_chunk_with_openrouter(self.wav)

        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("bad record mac", raised.exception.detail)

    def test_authentication_failure_is_not_retried(self):
        error = urllib_error.HTTPError(
            main.OPENROUTER_TRANSCRIPTION_URL,
            401,
            "Unauthorized",
            {},
            io.BytesIO(b'{"error":"unauthorized"}'),
        )

        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
            with mock.patch.object(main.urllib_request, "urlopen", side_effect=error) as urlopen:
                with self.assertRaises(HTTPException) as raised:
                    main.transcribe_chunk_with_openrouter(self.wav)

        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(urlopen.call_count, 1)


class LocalParakeetTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.wav = main.np.zeros(1600, dtype=main.np.float32)
        self.speech_segments = [(0, 1600)]

    def test_local_timeout_does_not_fall_back_to_openrouter_by_default(self):
        with mock.patch.object(main, "LOCAL_PARAKEET_ENABLED", True):
            with mock.patch.object(main, "LOCAL_PARAKEET_TIMEOUT_FALLBACK_ENABLED", False):
                with mock.patch.object(main, "get_ready_local_parakeet_model", side_effect=TimeoutError("loading")):
                    with mock.patch.object(main, "transcribe_chunks_with_openrouter") as openrouter:
                        with self.assertRaises(HTTPException) as raised:
                            main.transcribe_audio(self.wav, self.speech_segments, main.VoiceContext())

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Local Parakeet", raised.exception.detail)
        openrouter.assert_not_called()

    def test_local_failure_without_openrouter_key_reports_local_failure(self):
        with mock.patch.object(main, "LOCAL_PARAKEET_ENABLED", True):
            with mock.patch.dict(os.environ, {}, clear=True):
                with mock.patch.object(main, "get_ready_local_parakeet_model", side_effect=RuntimeError("model cache missing")):
                    with mock.patch.object(main, "transcribe_chunks_with_openrouter") as openrouter:
                        with self.assertRaises(HTTPException) as raised:
                            main.transcribe_audio(self.wav, self.speech_segments, main.VoiceContext())

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Local Parakeet is unavailable", raised.exception.detail)
        self.assertIn("model cache missing", raised.exception.detail)
        openrouter.assert_not_called()

    def test_cold_start_wait_does_not_count_against_active_transcription_budget(self):
        with mock.patch.object(main, "LOCAL_PARAKEET_ENABLED", True):
            with mock.patch.object(main, "get_ready_local_parakeet_model") as get_ready:
                with mock.patch.object(
                    main,
                    "transcribe_chunks_with_local_parakeet",
                    return_value=main.LocalTranscriptionResult("local transcript"),
                ):
                    with mock.patch.object(main, "time") as fake_time:
                        fake_time.perf_counter.side_effect = [100.0, 101.0]
                        text, metadata = main.transcribe_audio(
                            self.wav,
                            self.speech_segments,
                            main.VoiceContext(),
                        )

        get_ready.assert_called_once()
        self.assertEqual(text, "local transcript")
        self.assertEqual(metadata.provider, "local-parakeet")
        self.assertFalse(metadata.fallback_used)

    def test_auto_device_prefers_mps_when_available(self):
        fake_torch = mock.Mock()
        fake_torch.backends.mps.is_available.return_value = True

        with mock.patch.object(main, "LOCAL_PARAKEET_DEVICE", "auto"):
            self.assertEqual(main.select_local_parakeet_device(fake_torch), "mps")

    def test_auto_device_uses_cpu_when_mps_unavailable(self):
        fake_torch = mock.Mock()
        fake_torch.backends.mps.is_available.return_value = False

        with mock.patch.object(main, "LOCAL_PARAKEET_DEVICE", "auto"):
            self.assertEqual(main.select_local_parakeet_device(fake_torch), "cpu")

    def test_forced_mps_fails_when_unavailable(self):
        fake_torch = mock.Mock()
        fake_torch.backends.mps.is_available.return_value = False

        with mock.patch.object(main, "LOCAL_PARAKEET_DEVICE", "mps"):
            with self.assertRaises(RuntimeError):
                main.select_local_parakeet_device(fake_torch)

    def test_unload_local_parakeet_model_clears_resident_model_state(self):
        try:
            main.local_parakeet_model = object()
            main.local_parakeet_device = "mps"
            main.local_parakeet_last_used_at = 123.0
            with mock.patch.object(main.gc, "collect") as collect:
                with mock.patch.object(main, "clear_torch_device_cache") as clear_cache:
                    main.unload_local_parakeet_model("test")

            self.assertIsNone(main.local_parakeet_model)
            self.assertIsNone(main.local_parakeet_device)
            self.assertIsNone(main.local_parakeet_last_used_at)
            collect.assert_called_once()
            clear_cache.assert_called_once_with("mps")
        finally:
            main.local_parakeet_model = None
            main.local_parakeet_device = None
            main.local_parakeet_last_used_at = None

    def test_local_parakeet_import_environment_sets_writable_cache_dirs_and_quiets_nemo(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(main, "PYTHON_CACHE_ROOT", main.Path(temp_dir)):
                with mock.patch.dict(os.environ, {}, clear=True):
                    main.configure_local_parakeet_import_environment()

                    self.assertEqual(os.environ["MPLCONFIGDIR"], str(main.Path(temp_dir) / "matplotlib"))
                    self.assertEqual(os.environ["XDG_CACHE_HOME"], str(main.Path(temp_dir) / "xdg"))
                    self.assertTrue(main.Path(os.environ["MPLCONFIGDIR"]).is_dir())
                    self.assertTrue(main.Path(os.environ["XDG_CACHE_HOME"]).is_dir())
                    self.assertEqual(main.logging.getLogger("nemo_logger").level, main.logging.ERROR)


if __name__ == "__main__":
    unittest.main()

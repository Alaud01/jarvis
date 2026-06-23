import io
import json
import os
import ssl
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

    def test_destination_policies_include_literal_technical_modes(self):
        self.assertIn("literal technical mode", main.DESTINATION_POLICIES["code"])
        self.assertIn("literal technical mode", main.DESTINATION_POLICIES["terminal"])
        self.assertNotEqual(main.DESTINATION_POLICIES["chat"], main.DESTINATION_POLICIES["email"])

    def test_technical_prompt_disables_filler_and_style_rewrites(self):
        messages = main.build_refinement_messages(
            "git status no make that git diff",
            main.VoiceContext(destination="terminal"),
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
            destination="email",
            app=main.VoiceAppContext(name="Mail", bundleId="com.apple.mail", pid=123),
            field=main.VoiceFieldContext(textBeforeCursor="Hi Sam,"),
            accessibilityStatus="captured",
        )

        messages = main.build_refinement_messages("Meet at two, actually three.", context)

        self.assertIn("'actually'", messages[0]["content"])
        self.assertIn("'no, make that'", messages[0]["content"])
        self.assertIn("'scratch that'", messages[0]["content"])
        payload = json.loads(messages[1]["content"])
        self.assertEqual(payload["text_before_cursor"], "Hi Sam,")
        self.assertEqual(payload["raw_transcript"], "Meet at two, actually three.")

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
        self.assertIn("preserve their spelling and casing", messages[0]["content"])

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

    def test_openrouter_refinement_uses_mercury_nitro_with_low_reasoning(self):
        response = FakeResponse(
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "text": "Hello, world.",
                                    "applied_edits": ["punctuation"],
                                }
                            )
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
        self.assertEqual(payload["model"], "inception/mercury-2:nitro")
        self.assertEqual(payload["reasoning"], {"effort": "low"})
        self.assertEqual(payload["provider"]["sort"], "latency")
        self.assertEqual(
            payload["provider"]["preferred_min_throughput"],
            {"p50": main.OPENROUTER_REFINEMENT_MIN_THROUGHPUT},
        )
        self.assertTrue(payload["provider"]["require_parameters"])
        self.assertEqual(payload["response_format"]["type"], "json_schema")


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


if __name__ == "__main__":
    unittest.main()

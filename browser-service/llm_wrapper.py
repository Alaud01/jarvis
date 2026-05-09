import json
import re
from typing import Any, TypeVar

from ollama import AsyncClient as OllamaAsyncClient
from pydantic import BaseModel, ValidationError

from browser_use.llm.messages import BaseMessage
from browser_use.llm.ollama.serializer import OllamaMessageSerializer
from browser_use.llm.views import ChatInvokeCompletion

T = TypeVar('T', bound=BaseModel)


def extract_json_from_response(text: str) -> str | None:
    """
    Extract valid JSON from LLM output that may contain:
    - Markdown code fences (```json ... ``` or ``` ... ```)
    - Plain text before/after the JSON object
    - Trailing garbage after the closing brace
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # Try 1: The entire text is valid JSON
    try:
        json.loads(text)
        return text
    except (json.JSONDecodeError, ValueError):
        pass

    # Try 2: Strip markdown code fences
    fence_pattern = re.compile(r'```(?:json)?\s*\n?(.*?)\n?\s*```', re.DOTALL)
    fence_match = fence_pattern.search(text)
    if fence_match:
        extracted = fence_match.group(1).strip()
        try:
            json.loads(extracted)
            return extracted
        except (json.JSONDecodeError, ValueError):
            pass

    # Try 3: Find the outermost JSON object using brace counting
    start = text.find('{')
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i in range(start, len(text)):
        ch = text[i]

        if escape_next:
            escape_next = False
            continue

        if ch == '\\' and in_string:
            escape_next = True
            continue

        if ch == '"' and not escape_next:
            in_string = not in_string
            continue

        if in_string:
            continue

        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = text[start:i + 1]
                try:
                    json.loads(candidate)
                    return candidate
                except (json.JSONDecodeError, ValueError):
                    next_start = text.find('{', i + 1)
                    if next_start == -1:
                        return None
                    return extract_json_from_response(text[next_start:])

    return None


class RobustChatOllama:
    """
    Wraps ChatOllama to add robustness for models that don't reliably
    produce valid JSON when using structured output (Ollama's `format` parameter).

    When output_format is provided:
    - Sends format=schema to Ollama (to enable JSON mode)
    - Instead of relying on ChatOllama's internal model_validate_json,
      we sanitize the raw response (strip markdown fences, trailing text, etc.)
      before validating against the pydantic model ourselves.

    Per Ollama docs best practices:
    - temperature: 0 is set via ollama_options for deterministic output
    - JSON schema is passed as format parameter to constrain the model
    """

    def __init__(self, inner_llm):
        self._inner = inner_llm
        print(f"[RobustChatOllama] Initialized wrapper for model={inner_llm.model}")

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._inner, name)

    async def ainvoke(
        self, messages: list[BaseMessage], output_format: type[T] | None = None, **kwargs: Any
    ) -> ChatInvokeCompletion[T] | ChatInvokeCompletion[str]:

        if output_format is None:
            # Plain text path: no structured output, delegate directly
            return await self._inner.ainvoke(messages, output_format=None, **kwargs)

        # Structured output path: bypass inner validation to add our own
        # robustness layer. We call the Ollama client directly with format=schema
        # (to keep JSON mode enabled) but handle parsing + validation ourselves.
        ollama_messages = OllamaMessageSerializer.serialize_messages(messages)
        schema = output_format.model_json_schema()

        client: OllamaAsyncClient = self._inner.get_client()
        response = await client.chat(
            model=self._inner.model,
            messages=ollama_messages,
            format=schema,
            options=self._inner.ollama_options,
        )

        raw_content = response.message.content or ''
        if not raw_content or not raw_content.strip():
            from browser_use.llm.exceptions import ModelProviderError
            print(f"[RobustChatOllama] Empty response from model {self._inner.model}")
            raise ModelProviderError(
                message=f"Empty response from model {self._inner.model}",
                model=self._inner.model,
            )

        # Sanitize: extract JSON from potentially messy LLM output
        json_str = extract_json_from_response(raw_content)
        if json_str is None:
            from browser_use.llm.exceptions import ModelProviderError
            print(
                f"[RobustChatOllama] Could not extract JSON from response "
                f"(len={len(raw_content)}). First 300 chars: {raw_content[:300]}"
            )
            raise ModelProviderError(
                message=(
                    f"Could not extract valid JSON from model response. "
                    f"Response was {len(raw_content)} chars. First 200 chars: {raw_content[:200]}"
                ),
                model=self._inner.model,
            )

        if json_str != raw_content.strip():
            print(
                f"[RobustChatOllama] Extracted JSON from messy response. "
                f"Original: {len(raw_content)} chars, extracted: {len(json_str)} chars"
            )

        # Validate against the pydantic model
        try:
            parsed = output_format.model_validate_json(json_str)
        except ValidationError as e:
            from browser_use.llm.exceptions import ModelProviderError
            print(
                f"[RobustChatOllama] Pydantic validation failed for extracted JSON. "
                f"Error: {e}. JSON (first 300 chars): {json_str[:300]}"
            )
            raise ModelProviderError(
                message=str(e),
                model=self._inner.model,
            ) from e

        print(f"[RobustChatOllama] Successfully parsed structured output for model={self._inner.model}")
        return ChatInvokeCompletion(completion=parsed, usage=None)
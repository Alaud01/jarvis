import json
import re
from collections.abc import Mapping
from typing import Any, TypeVar

import httpx
from anthropic import NotGiven, omit
from anthropic.types import CacheControlEphemeralParam, Message, ToolParam
from anthropic.types.tool_choice_tool_param import ToolChoiceToolParam
from ollama import AsyncClient as OllamaAsyncClient
from pydantic import BaseModel, ValidationError

from browser_use.llm.anthropic.chat import ChatAnthropic
from browser_use.llm.anthropic.serializer import AnthropicMessageSerializer
from browser_use.llm.exceptions import ModelProviderError, ModelRateLimitError
from browser_use.llm.messages import BaseMessage
from browser_use.llm.ollama.serializer import OllamaMessageSerializer
from browser_use.llm.schema import SchemaOptimizer
from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage

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


def repair_evaluate_expression_schema(value: Any) -> tuple[Any, bool]:
    """
    Repair the narrow browser-use schema mismatch seen from some models:
    {"evaluate": {"expression": "..."}} should be {"evaluate": {"code": "..."}}.
    """
    if isinstance(value, list):
        repaired_items = []
        changed = False
        for item in value:
            repaired_item, item_changed = repair_evaluate_expression_schema(item)
            repaired_items.append(repaired_item)
            changed = changed or item_changed
        return repaired_items, changed

    if not isinstance(value, dict):
        return value, False

    repaired: dict[str, Any] = {}
    changed = False
    for key, child_value in value.items():
        repaired_child, child_changed = repair_evaluate_expression_schema(child_value)
        repaired[key] = repaired_child
        changed = changed or child_changed

    evaluate_value = repaired.get("evaluate")
    if (
        isinstance(evaluate_value, dict)
        and "expression" in evaluate_value
        and "code" not in evaluate_value
    ):
        evaluate_repair = dict(evaluate_value)
        evaluate_repair["code"] = evaluate_repair.pop("expression")
        repaired["evaluate"] = evaluate_repair
        changed = True

    return repaired, changed


def repair_json_for_known_schema_mismatches(json_str: str) -> str | None:
    try:
        parsed = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return None

    repaired, changed = repair_evaluate_expression_schema(parsed)
    if not changed:
        return None

    return json.dumps(repaired)


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

    def __init__(self, inner_llm, keep_alive: str | int | None = None):
        self._inner = inner_llm
        self._keep_alive = keep_alive
        keep_alive_label = f", keep_alive={keep_alive}" if keep_alive is not None else ""
        print(f"[RobustChatOllama] Initialized wrapper for model={inner_llm.model}{keep_alive_label}")

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
        chat_kwargs: dict[str, Any] = {
            "model": self._inner.model,
            "messages": ollama_messages,
            "format": schema,
            "options": self._inner.ollama_options,
        }
        if self._keep_alive is not None:
            chat_kwargs["keep_alive"] = self._keep_alive

        response = await client.chat(**chat_kwargs)

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
            repaired_json_str = repair_json_for_known_schema_mismatches(json_str)
            if repaired_json_str is not None:
                try:
                    parsed = output_format.model_validate_json(repaired_json_str)
                    print(
                        f"[RobustChatOllama] Repaired known structured output schema mismatch "
                        f"for model={self._inner.model}"
                    )
                    return ChatInvokeCompletion(completion=parsed, usage=None)
                except ValidationError:
                    pass

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


class OpenCodeGoChatAnthropic(ChatAnthropic):
    """
    ChatAnthropic subclass for OpenCode Go's Qwen models served via
    Anthropic-compatible endpoints.

    Qwen models behind the OpenCode Go proxy have thinking enabled by default.
    When thinking is active, the endpoint rejects tool_choice set to "required"
    or a specific tool object. This subclass explicitly disables thinking when
    using forced tool_choice (structured output path), resolving the conflict.
    """

    async def ainvoke(
        self, messages: list[BaseMessage], output_format: type[T] | None = None, **kwargs: Any
    ) -> ChatInvokeCompletion[T] | ChatInvokeCompletion[str]:
        anthropic_messages, system_prompt = AnthropicMessageSerializer.serialize_messages(messages)

        try:
            if output_format is None:
                response = await self.get_client().messages.create(
                    model=self.model,
                    messages=anthropic_messages,
                    system=system_prompt or omit,
                    **self._get_client_params_for_invoke(),
                )

                if not isinstance(response, Message):
                    raise ModelProviderError(
                        message=f'Unexpected response type: {type(response).__name__}',
                        status_code=502,
                        model=self.name,
                    )

                usage = self._get_usage(response)
                first_content = response.content[0]
                response_text = first_content.text if hasattr(first_content, 'text') else str(first_content)

                return ChatInvokeCompletion(
                    completion=response_text,
                    usage=usage,
                    stop_reason=response.stop_reason,
                )
            else:
                tool_name = output_format.__name__
                schema = SchemaOptimizer.create_optimized_json_schema(output_format)
                if 'title' in schema:
                    del schema['title']

                tool = ToolParam(
                    name=tool_name,
                    description=f'Extract information in the format of {tool_name}',
                    input_schema=schema,
                    cache_control=CacheControlEphemeralParam(type='ephemeral'),
                )

                tool_choice = ToolChoiceToolParam(type='tool', name=tool_name)

                invoke_params = self._get_client_params_for_invoke()

                response = await self.get_client().messages.create(
                    model=self.model,
                    messages=anthropic_messages,
                    tools=[tool],
                    system=system_prompt or omit,
                    tool_choice=tool_choice,
                    thinking={"type": "disabled"},
                    **invoke_params,
                )

                if not isinstance(response, Message):
                    raise ModelProviderError(
                        message=f'Unexpected response type: {type(response).__name__}',
                        status_code=502,
                        model=self.name,
                    )

                usage = self._get_usage(response)

                for content_block in response.content:
                    if hasattr(content_block, 'type') and content_block.type == 'tool_use':
                        try:
                            return ChatInvokeCompletion(
                                completion=output_format.model_validate(content_block.input),
                                usage=usage,
                                stop_reason=response.stop_reason,
                            )
                        except Exception as e:
                            _input = content_block.input
                            if isinstance(_input, str):
                                _input = json.loads(_input)
                            elif isinstance(_input, dict):
                                for key, value in _input.items():
                                    if isinstance(value, str) and value.startswith(('[', '{')):
                                        try:
                                            _input[key] = json.loads(value)
                                        except json.JSONDecodeError:
                                            cleaned = value.replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
                                            try:
                                                _input[key] = json.loads(cleaned)
                                            except json.JSONDecodeError:
                                                pass
                            else:
                                raise
                            return ChatInvokeCompletion(
                                completion=output_format.model_validate(_input),
                                usage=usage,
                                stop_reason=response.stop_reason,
                            )

                raise ValueError('Expected tool use in response but none found')

        except Exception as e:
            if isinstance(e, (ModelProviderError, ModelRateLimitError)):
                raise
            from anthropic import APIConnectionError, APIStatusError, RateLimitError
            if isinstance(e, APIConnectionError):
                raise ModelProviderError(message=e.message, model=self.name) from e
            if isinstance(e, RateLimitError):
                raise ModelRateLimitError(message=e.message, model=self.name) from e
            if isinstance(e, APIStatusError):
                raise ModelProviderError(message=e.message, status_code=e.status_code, model=self.name) from e
            raise ModelProviderError(message=str(e), model=self.name) from e

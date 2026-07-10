import re
from abc import ABC, abstractmethod

import httpx

from app.config import Settings
from app.schemas import VocabularyItem

MOCK_REPLACEMENTS = [
    (r"\bwhispir flow\b", "Wispr Flow"),
    (r"\bwisper flow\b", "Wispr Flow"),
    (r"\bwhisper flow\b", "Wispr Flow"),
    (r"\brock em\b", "ROCm"),
    (r"\brock m\b", "ROCm"),
    (r"\bfireworks ay eye\b", "Fireworks AI"),
    (r"\bfireworks ai eyes?\b", "Fireworks AI"),
    (r"\bjemma\b", "Gemma"),
]

KNOWN_SPEECH_FIXES = [
    '"whisper flow", "wisper flow", or "whispir flow" -> "Wispr Flow"',
    '"rock em" or "rock m" -> "ROCm"',
    '"fireworks ay eye" or "fireworks AI eyes" -> "Fireworks AI"',
    '"jemma" -> "Gemma"',
]


class CorrectionEngine(ABC):
    name: str

    @abstractmethod
    async def correct(self, text: str, context: str, vocabulary: list[VocabularyItem]) -> str:
        raise NotImplementedError


class MockRuleCorrectionEngine(CorrectionEngine):
    name = "mock-rules"

    async def correct(self, text: str, context: str, vocabulary: list[VocabularyItem]) -> str:
        corrected = text.strip()
        for pattern, replacement in MOCK_REPLACEMENTS:
            corrected = re.sub(pattern, replacement, corrected, flags=re.IGNORECASE)

        corrected = re.sub(r"\bWispr Flow style\b", "Wispr Flow-style", corrected, flags=re.IGNORECASE)
        corrected = re.sub(r"\s+", " ", corrected).strip()
        if corrected and corrected[-1] not in ".!?":
            corrected += "."
        return corrected


class OllamaCorrectionEngine(CorrectionEngine):
    name = "ollama"

    def __init__(self, settings: Settings, fallback: CorrectionEngine) -> None:
        self.settings = settings
        self.fallback = fallback

    async def correct(self, text: str, context: str, vocabulary: list[VocabularyItem]) -> str:
        raw_text = text.strip()
        if not raw_text:
            return ""

        draft = await self.fallback.correct(raw_text, context, vocabulary)
        try:
            async with httpx.AsyncClient(timeout=self.settings.ollama_timeout_seconds) as client:
                response = await client.post(
                    f"{self.settings.ollama_base_url.rstrip('/')}/api/chat",
                    json={
                        "model": self.settings.ollama_model,
                        "stream": False,
                        "messages": [
                            {"role": "system", "content": build_system_prompt()},
                            {"role": "user", "content": build_user_prompt(raw_text, draft, context, vocabulary)},
                        ],
                        "options": {
                            "temperature": 0.1,
                            "top_p": 0.8,
                            "num_predict": 500,
                        },
                    },
                )
            response.raise_for_status()
            corrected = clean_model_output(response.json().get("message", {}).get("content", ""))
            if corrected:
                return await self.fallback.correct(corrected, context, vocabulary)
        except (httpx.HTTPError, ValueError):
            pass

        return draft


def build_system_prompt() -> str:
    return (
        "You are Voxly's correction engine for dictated text. "
        "Correct likely speech-to-text mistakes, punctuation, capitalization, and specialized terms. "
        "Use the project context only to resolve ambiguous wording. "
        "Prefer exact vocabulary terms when they match the speaker's intent. "
        "Preserve the original meaning and do not add new facts, claims, names, or ideas. "
        "Return only the corrected text with no labels, markdown, explanations, or alternatives."
    )


def build_user_prompt(text: str, draft: str, context: str, vocabulary: list[VocabularyItem]) -> str:
    terms = format_vocabulary(vocabulary)
    fixes = "\n".join(f"- {fix}" for fix in KNOWN_SPEECH_FIXES)
    return (
        f"Context:\n{context.strip() or '(none)'}\n\n"
        f"Vocabulary terms:\n{terms}\n\n"
        f"Known phonetic fixes:\n{fixes}\n\n"
        f"Raw transcript:\n{text}\n\n"
        f"Rule-normalized draft:\n{draft}\n\n"
        "Use the draft as the baseline. Make only necessary polish edits. "
        "Do not reintroduce phonetic spellings from the raw transcript.\n\n"
        "Corrected text:"
    )


def format_vocabulary(vocabulary: list[VocabularyItem]) -> str:
    if not vocabulary:
        return "(none)"

    lines = []
    for item in vocabulary[:80]:
        note = item.notes.strip()
        lines.append(f"- {item.term}" + (f": {note}" if note else ""))
    return "\n".join(lines)


def clean_model_output(output: str) -> str:
    corrected = output.strip()
    corrected = re.sub(r"^```(?:text)?\s*", "", corrected, flags=re.IGNORECASE)
    corrected = re.sub(r"\s*```$", "", corrected)
    corrected = re.sub(r"^(corrected text|corrected|output):\s*", "", corrected, flags=re.IGNORECASE)
    if len(corrected) >= 2 and corrected[0] == corrected[-1] and corrected[0] in "\"'":
        corrected = corrected[1:-1]
    return corrected.strip()


def build_correction_engine(settings: Settings) -> CorrectionEngine:
    fallback = MockRuleCorrectionEngine()
    if settings.correction_provider.lower().strip() == "ollama":
        return OllamaCorrectionEngine(settings, fallback)
    return MockRuleCorrectionEngine()

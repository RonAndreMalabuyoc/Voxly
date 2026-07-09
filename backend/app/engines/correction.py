import re
from abc import ABC, abstractmethod

from app.schemas import VocabularyItem

MOCK_REPLACEMENTS = [
    (r"\bwisper flow\b", "Wispr Flow"),
    (r"\bwhisper flow\b", "Wispr Flow"),
    (r"\brock em\b", "ROCm"),
    (r"\bfireworks ay eye\b", "Fireworks AI"),
    (r"\bjemma\b", "Gemma"),
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


def build_correction_engine() -> CorrectionEngine:
    return MockRuleCorrectionEngine()

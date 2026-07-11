from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx

from app.config import Settings


@dataclass
class TranscriptionResult:
    transcript: str
    confidence: float | None = None
    alternatives: list[str] | None = None


class TranscriptionUnavailableError(RuntimeError):
    pass


class TranscriptionEngine(ABC):
    name: str

    @abstractmethod
    async def transcribe(self, text: str, source: str) -> str:
        raise NotImplementedError

    @abstractmethod
    async def transcribe_audio(
        self,
        audio: bytes,
        content_type: str,
        filename: str,
        keyterms: list[str] | None = None,
    ) -> TranscriptionResult:
        raise NotImplementedError


class ManualTranscriptEngine(TranscriptionEngine):
    name = "manual"

    async def transcribe(self, text: str, source: str) -> str:
        return " ".join(text.strip().split())

    async def transcribe_audio(
        self,
        audio: bytes,
        content_type: str,
        filename: str,
        keyterms: list[str] | None = None,
    ) -> TranscriptionResult:
        raise TranscriptionUnavailableError(
            "Audio recording works in this browser, but no backend speech-to-text provider is configured. "
            "Set STT_PROVIDER=deepgram and DEEPGRAM_API_KEY to transcribe recorded audio."
        )


class DeepgramTranscriptionEngine(TranscriptionEngine):
    name = "deepgram"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def transcribe(self, text: str, source: str) -> str:
        return " ".join(text.strip().split())

    async def transcribe_audio(
        self,
        audio: bytes,
        content_type: str,
        filename: str,
        keyterms: list[str] | None = None,
    ) -> TranscriptionResult:
        if not self.settings.deepgram_api_key:
            raise TranscriptionUnavailableError("DEEPGRAM_API_KEY is missing.")

        params = [
            ("model", self.settings.deepgram_model),
            ("smart_format", "true"),
            ("punctuate", "true"),
        ]
        if self.settings.deepgram_language.strip():
            params.append(("language", self.settings.deepgram_language.strip()))
        params.extend(("keyterm", keyterm) for keyterm in keyterms or [])
        headers = {
            "Authorization": f"Token {self.settings.deepgram_api_key}",
            "Content-Type": content_type or "application/octet-stream",
        }
        try:
            async with httpx.AsyncClient(timeout=self.settings.deepgram_timeout_seconds) as client:
                response = await client.post(
                    self.settings.deepgram_base_url,
                    params=params,
                    headers=headers,
                    content=audio,
                )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise TranscriptionUnavailableError(
                "Deepgram transcription timed out. Try a shorter recording or check your internet connection."
            ) from exc
        except httpx.ConnectError as exc:
            raise TranscriptionUnavailableError(
                "Voxly could not connect to Deepgram. Check your internet connection, then try again."
            ) from exc
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:240].strip()
            message = f"Deepgram returned {exc.response.status_code}."
            if detail:
                message = f"{message} {detail}"
            raise TranscriptionUnavailableError(message) from exc
        data = response.json()
        channels = data.get("results", {}).get("channels", [])
        if not channels:
            return TranscriptionResult(transcript="")
        alternatives = channels[0].get("alternatives", [])
        if not alternatives:
            return TranscriptionResult(transcript="")
        transcript = alternatives[0].get("transcript", "").strip()
        confidence = alternatives[0].get("confidence")
        if confidence is None:
            confidence = average_word_confidence(alternatives[0].get("words", []))
        return TranscriptionResult(
            transcript=transcript,
            confidence=confidence,
            alternatives=[alternative.get("transcript", "").strip() for alternative in alternatives if alternative.get("transcript", "").strip()],
        )


def average_word_confidence(words: list[dict]) -> float | None:
    confidences = [word.get("confidence") for word in words if isinstance(word.get("confidence"), (int, float))]
    if not confidences:
        return None
    return sum(confidences) / len(confidences)


def build_transcription_engine(settings: Settings) -> TranscriptionEngine:
    if settings.stt_provider.lower().strip() == "deepgram":
        return DeepgramTranscriptionEngine(settings)
    return ManualTranscriptEngine()

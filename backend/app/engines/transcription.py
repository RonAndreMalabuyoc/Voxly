from abc import ABC, abstractmethod

import httpx

from app.config import Settings


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
    ) -> str:
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
    ) -> str:
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
    ) -> str:
        if not self.settings.deepgram_api_key:
            raise TranscriptionUnavailableError("DEEPGRAM_API_KEY is missing.")

        params = [
            ("model", self.settings.deepgram_model),
            ("smart_format", "true"),
            ("punctuate", "true"),
        ]
        params.extend(("keyterm", keyterm) for keyterm in keyterms or [])
        headers = {
            "Authorization": f"Token {self.settings.deepgram_api_key}",
            "Content-Type": content_type or "application/octet-stream",
        }
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                self.settings.deepgram_base_url,
                params=params,
                headers=headers,
                content=audio,
            )
        response.raise_for_status()
        data = response.json()
        channels = data.get("results", {}).get("channels", [])
        if not channels:
            return ""
        alternatives = channels[0].get("alternatives", [])
        if not alternatives:
            return ""
        return alternatives[0].get("transcript", "").strip()


def build_transcription_engine(settings: Settings) -> TranscriptionEngine:
    if settings.stt_provider.lower().strip() == "deepgram":
        return DeepgramTranscriptionEngine(settings)
    return ManualTranscriptEngine()

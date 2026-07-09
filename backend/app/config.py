from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_path: str = "backend/data/voxly.db"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    stt_provider: str = "mock"
    deepgram_api_key: str = ""
    deepgram_base_url: str = "https://api.deepgram.com/v1/listen"
    deepgram_model: str = "nova-3"
    deepgram_keyterms: str = "Wispr Flow,ROCm,Fireworks AI,Gemma,AMD Developer Cloud,Codex,FastAPI,SQLite"

    model_config = SettingsConfigDict(env_file=(".env", "../.env"), env_file_encoding="utf-8")

    @property
    def database_file(self) -> Path:
        return Path(self.database_path)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def deepgram_keyterm_list(self) -> list[str]:
        return [term.strip() for term in self.deepgram_keyterms.split(",") if term.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()

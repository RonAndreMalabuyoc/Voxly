from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool
    correction_engine: str
    transcription: str


class TranscribeRequest(BaseModel):
    text: str = ""
    source: str = "browser"


class TranscribeResponse(BaseModel):
    transcript: str
    source: str
    transcription_engine: str
    needs_manual_transcript: bool = False
    message: str = ""


class CorrectRequest(BaseModel):
    text: str = Field(default="", description="Raw dictated transcript.")
    context: str = Field(default="", description="Optional project or writing context.")


class CorrectResponse(BaseModel):
    raw_text: str
    corrected_text: str
    correction_engine: str


class VocabularyItem(BaseModel):
    id: int
    term: str
    notes: str = ""


class VocabularyCreate(BaseModel):
    term: str = Field(min_length=1, max_length=120)
    notes: str = Field(default="", max_length=500)


class CorrectionRecord(BaseModel):
    id: int
    raw_text: str
    corrected_text: str
    context: str = ""
    provider: str
    created_at: str


class CorrectionCreate(BaseModel):
    raw_text: str
    corrected_text: str
    context: str = ""
    provider: str = "manual"

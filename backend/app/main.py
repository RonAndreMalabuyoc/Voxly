from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import Database
from app.engines.correction import build_correction_engine
from app.engines.transcription import TranscriptionUnavailableError, build_transcription_engine
from app.schemas import (
    CorrectionCreate,
    CorrectionRecord,
    CorrectRequest,
    CorrectResponse,
    HealthResponse,
    TranscribeRequest,
    TranscribeResponse,
    VocabularyCreate,
    VocabularyItem,
)

settings = get_settings()
db = Database(settings.database_file)
correction_engine = build_correction_engine()
transcription_engine = build_transcription_engine(settings)

app = FastAPI(
    title="Voxly API",
    description="Context-aware dictation API with cross-browser audio capture and rule-based correction.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    db.init()


def get_db() -> Database:
    return db


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, correction_engine=correction_engine.name, transcription=transcription_engine.name)


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    transcript = await transcription_engine.transcribe(request.text, request.source)
    return TranscribeResponse(
        transcript=transcript,
        source=request.source,
        transcription_engine=transcription_engine.name,
    )


@app.post("/api/transcribe/audio", response_model=TranscribeResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    database: Database = Depends(get_db),
) -> TranscribeResponse:
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio file is empty.")

    keyterms = list_vocabulary_terms(database)
    try:
        transcript = await transcription_engine.transcribe_audio(
            audio=audio,
            content_type=file.content_type or "application/octet-stream",
            filename=file.filename or "recording.webm",
            keyterms=keyterms,
        )
    except TranscriptionUnavailableError as exc:
        return TranscribeResponse(
            transcript="",
            source="audio",
            transcription_engine=transcription_engine.name,
            needs_manual_transcript=True,
            message=str(exc),
        )

    return TranscribeResponse(
        transcript=transcript,
        source="audio",
        transcription_engine=transcription_engine.name,
    )


@app.post("/api/correct", response_model=CorrectResponse)
async def correct(request: CorrectRequest, database: Database = Depends(get_db)) -> CorrectResponse:
    vocabulary = list_vocabulary_items(database)
    corrected = await correction_engine.correct(request.text, request.context, vocabulary)
    with database.connect() as conn:
        conn.execute(
            """
            INSERT INTO corrections (raw_text, corrected_text, context, provider)
            VALUES (?, ?, ?, ?)
            """,
            (request.text, corrected, request.context, correction_engine.name),
        )
    return CorrectResponse(raw_text=request.text, corrected_text=corrected, correction_engine=correction_engine.name)


@app.get("/api/vocabulary", response_model=list[VocabularyItem])
def list_vocabulary(database: Database = Depends(get_db)) -> list[VocabularyItem]:
    return list_vocabulary_items(database)


def list_vocabulary_items(database: Database) -> list[VocabularyItem]:
    with database.connect() as conn:
        rows = conn.execute("SELECT id, term, notes FROM vocabulary ORDER BY term").fetchall()
    return [VocabularyItem(**dict(row)) for row in rows]


def list_vocabulary_terms(database: Database) -> list[str]:
    with database.connect() as conn:
        rows = conn.execute("SELECT term FROM vocabulary ORDER BY term").fetchall()
    return [row["term"] for row in rows]


@app.post("/api/vocabulary", response_model=VocabularyItem)
def create_vocabulary(item: VocabularyCreate, database: Database = Depends(get_db)) -> VocabularyItem:
    try:
        with database.connect() as conn:
            cursor = conn.execute(
                "INSERT INTO vocabulary (term, notes) VALUES (?, ?)",
                (item.term.strip(), item.notes.strip()),
            )
            row_id = cursor.lastrowid
            row = conn.execute("SELECT id, term, notes FROM vocabulary WHERE id = ?", (row_id,)).fetchone()
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Vocabulary term already exists or could not be saved.") from exc
    return VocabularyItem(**dict(row))


@app.get("/api/corrections", response_model=list[CorrectionRecord])
def list_corrections(database: Database = Depends(get_db)) -> list[CorrectionRecord]:
    with database.connect() as conn:
        rows = conn.execute(
            """
            SELECT id, raw_text, corrected_text, context, provider, created_at
            FROM corrections
            ORDER BY created_at DESC
            LIMIT 25
            """
        ).fetchall()
    return [CorrectionRecord(**dict(row)) for row in rows]


@app.post("/api/corrections", response_model=CorrectionRecord)
def create_correction(record: CorrectionCreate, database: Database = Depends(get_db)) -> CorrectionRecord:
    with database.connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO corrections (raw_text, corrected_text, context, provider)
            VALUES (?, ?, ?, ?)
            """,
            (record.raw_text, record.corrected_text, record.context, record.provider),
        )
        row = conn.execute(
            """
            SELECT id, raw_text, corrected_text, context, provider, created_at
            FROM corrections
            WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
    return CorrectionRecord(**dict(row))


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")

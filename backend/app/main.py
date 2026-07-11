import re
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import Database
from app.dictionary import MarkdownDictionary
from app.engines.correction import build_correction_engine
from app.engines.transcription import TranscriptionUnavailableError, build_transcription_engine
from app.schemas import (
    CorrectionCreate,
    CorrectionRecord,
    CorrectRequest,
    CorrectResponse,
    DiscoverRequest,
    DiscoveredWord,
    HealthResponse,
    TranscribeRequest,
    TranscribeResponse,
    VocabularyCreate,
    VocabularyItem,
    VocabularyUpdate,
)

settings = get_settings()
db = Database(settings.database_file)
dictionary = MarkdownDictionary(settings.dictionary_file)
correction_engine = build_correction_engine(settings)
transcription_engine = build_transcription_engine(settings)

app = FastAPI(
    title="Voxly API",
    description="Context-aware dictation API with cross-browser audio capture and local AI correction.",
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
    dictionary.init(list_vocabulary_seed_items(db))


def get_db() -> Database:
    return db


def get_dictionary() -> MarkdownDictionary:
    return dictionary


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
    context: str = Form(default=""),
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> TranscribeResponse:
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="Audio file is empty.")

    dictionary_keyterms = personal_dictionary.list_transcription_keyterms()
    keyterms = merge_keyterms(
        dictionary_keyterms,
        build_compound_keyterms(dictionary_keyterms),
        extract_transcription_context_keyterms(context),
    )
    try:
        result = await transcription_engine.transcribe_audio(
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

    transcript = result.transcript
    review_suggestion = await build_review_suggestion(transcript, context, personal_dictionary.list_terms())
    needs_review = should_review_transcript(transcript, review_suggestion, result.confidence, result.alternatives or [])

    return TranscribeResponse(
        transcript=transcript,
        source="audio",
        transcription_engine=transcription_engine.name,
        needs_review=needs_review,
        review_suggestion=review_suggestion if needs_review else "",
        confidence=result.confidence,
        message=build_review_message(needs_review, result.confidence),
    )


def merge_keyterms(*groups: list[str]) -> list[str]:
    merged = []
    seen = set()
    for group in groups:
        for term in group:
            clean = " ".join(term.strip().split())
            key = clean.lower()
            if clean and key not in seen:
                seen.add(key)
                merged.append(clean)
    return merged[:60]


async def build_review_suggestion(transcript: str, context: str, vocabulary: list[VocabularyItem]) -> str:
    if not transcript.strip():
        return ""
    suggestion = await correction_engine.correct(transcript, context, vocabulary)
    return suggestion.strip()


def should_review_transcript(transcript: str, suggestion: str, confidence: float | None, alternatives: list[str]) -> bool:
    if not transcript.strip():
        return False
    if confidence is not None and confidence < 0.82:
        return True
    if suggestion and normalize_for_review(transcript) != normalize_for_review(suggestion):
        return True
    return has_meaningful_alternative_disagreement(transcript, alternatives)


def build_review_message(needs_review: bool, confidence: float | None) -> str:
    if not needs_review:
        return ""
    if confidence is not None and confidence < 0.82:
        return "Deepgram was not very confident, so Gemma reviewed the transcript. Use the suggestion or edit manually."
    return "Gemma reviewed the transcript and found a possible correction. Use the suggestion or edit manually."


def has_meaningful_alternative_disagreement(transcript: str, alternatives: list[str]) -> bool:
    baseline = normalize_for_review(transcript)
    if not baseline:
        return False
    for alternative in alternatives[1:]:
        candidate = normalize_for_review(alternative)
        if candidate and candidate != baseline:
            return True
    return False


def normalize_for_review(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def extract_transcription_context_keyterms(context: str) -> list[str]:
    if not context.strip():
        return []

    candidates: list[str] = []
    candidates.extend(re.findall(r"[`\"']([^`\"']{2,60})[`\"']", context))

    for line in context.splitlines():
        if re.search(r"\b(french|spanish|terms?|names?|words?)\b\s*:", line, flags=re.IGNORECASE):
            _, _, value = line.partition(":")
            candidates.extend(split_context_terms(value))

    for match in re.finditer(r"\b(?:terms like|prefer terms like|words like)\s+([^.\n]+)", context, flags=re.IGNORECASE):
        candidates.extend(split_context_terms(match.group(1)))

    candidates.extend(re.findall(r"\b[A-Za-zÀ-ÖØ-öø-ÿ]*[À-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*\b", context))
    return merge_keyterms([clean_context_keyterm(term) for term in candidates if is_context_keyterm(term)])


def build_compound_keyterms(keyterms: list[str]) -> list[str]:
    proper_terms = [term for term in keyterms if is_compound_keyterm_atom(term)]
    compounds: list[str] = []
    for index, first in enumerate(proper_terms):
        for second in proper_terms[index + 1 :]:
            phrase = f"{first} {second}"
            if len(phrase) <= 60:
                compounds.append(phrase)
    return compounds[:40]


def is_compound_keyterm_atom(term: str) -> bool:
    clean = clean_context_keyterm(term)
    if not clean or " " in clean:
        return False
    if len(clean) < 4 or len(clean) > 24:
        return False
    return clean[:1].isupper() and clean[1:].islower()


def split_context_terms(value: str) -> list[str]:
    return [part.strip() for part in re.split(r",|;|\band\b|\by\b|\bet\b", value, flags=re.IGNORECASE)]


def is_context_keyterm(value: str) -> bool:
    clean = clean_context_keyterm(value)
    if len(clean) < 2 or len(clean) > 60:
        return False
    if clean.lower() in {"and", "or", "the", "a", "an", "y", "et", "de", "la", "le", "el"}:
        return False
    return bool(re.search(r"[A-Za-zÀ-ÖØ-öø-ÿ]", clean))


def clean_context_keyterm(value: str) -> str:
    return " ".join(value.strip(" .,:;!?()[]{}").split())


@app.post("/api/correct", response_model=CorrectResponse)
async def correct(
    request: CorrectRequest,
    database: Database = Depends(get_db),
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> CorrectResponse:
    vocabulary = personal_dictionary.list_terms()
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
def list_vocabulary(personal_dictionary: MarkdownDictionary = Depends(get_dictionary)) -> list[VocabularyItem]:
    return personal_dictionary.list_terms()


def list_vocabulary_seed_items(database: Database) -> list[tuple[str, str]]:
    with database.connect() as conn:
        rows = conn.execute("SELECT term, notes FROM vocabulary ORDER BY term").fetchall()
    return [(row["term"], row["notes"]) for row in rows]


@app.post("/api/vocabulary", response_model=VocabularyItem)
def create_vocabulary(
    item: VocabularyCreate,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> VocabularyItem:
    try:
        return personal_dictionary.add_term(item.term, item.notes)
    except Exception as exc:
        raise HTTPException(status_code=409, detail="Vocabulary term already exists or could not be saved.") from exc


@app.put("/api/vocabulary/{item_id}", response_model=VocabularyItem)
def update_vocabulary(
    item_id: int,
    item: VocabularyUpdate,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> VocabularyItem:
    try:
        return personal_dictionary.update_term(item_id, item.term, item.notes)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Vocabulary term was not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.delete("/api/vocabulary/{item_id}", status_code=204)
def delete_vocabulary(
    item_id: int,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> None:
    try:
        personal_dictionary.delete_term(item_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Vocabulary term was not found.") from exc


@app.get("/api/dictionary/discovered", response_model=list[DiscoveredWord])
def list_discovered_words(personal_dictionary: MarkdownDictionary = Depends(get_dictionary)) -> list[DiscoveredWord]:
    return personal_dictionary.list_pending()


@app.post("/api/dictionary/discover", response_model=list[DiscoveredWord])
def discover_words(
    request: DiscoverRequest,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> list[DiscoveredWord]:
    return personal_dictionary.discover(request.text)


@app.post("/api/dictionary/discovered", response_model=list[DiscoveredWord])
def flag_discovered_word(
    item: VocabularyCreate,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> list[DiscoveredWord]:
    try:
        return personal_dictionary.flag_pending(item.term)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/dictionary/discovered/{item_id}/accept", response_model=VocabularyItem)
def accept_discovered_word(
    item_id: int,
    item: VocabularyCreate,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> VocabularyItem:
    try:
        return personal_dictionary.accept_pending(item_id, item.term, item.notes)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Discovered word was not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.delete("/api/dictionary/discovered/{item_id}", status_code=204)
def dismiss_discovered_word(
    item_id: int,
    personal_dictionary: MarkdownDictionary = Depends(get_dictionary),
) -> None:
    try:
        personal_dictionary.dismiss_pending(item_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Discovered word was not found.") from exc


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

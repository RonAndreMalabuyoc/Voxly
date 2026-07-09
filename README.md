# Voxly

Voxly is a context-aware dictation app that turns rough speech transcripts into polished, accurate text using personal vocabulary and project context.

This first version is intentionally small: a focused browser dictation notepad with microphone transcription, a raw transcript view, deterministic demo corrections, vocabulary editing, and SQLite-backed history. It does not call an LLM yet.

## What Works Now

- Cross-browser microphone recording using the MediaRecorder API.
- Backend audio transcription endpoint with a provider adapter.
- Manual raw transcript fallback when no speech-to-text provider is configured.
- Notepad area for appending raw or corrected dictation.
- Rule-based demo corrections for hackathon vocabulary:
  - `whisper flow` -> `Wispr Flow`
  - `wisper flow` -> `Wispr Flow`
  - `rock em` -> `ROCm`
  - `fireworks ay eye` -> `Fireworks AI`
  - `jemma` -> `Gemma`
- FastAPI backend with text/audio transcription and correction endpoints.
- SQLite storage for vocabulary and correction history.
- Dockerfile and docker-compose for containerized demo deployment.

## Project Structure

```text
backend/   FastAPI API, SQLite storage, correction/transcription adapters
frontend/  React + Vite + TypeScript app
```

## Local Development

Run the backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Run the frontend in another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Environment

Copy `.env.example` to `.env` for local use.

```bash
DATABASE_PATH=backend/data/voxly.db
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
STT_PROVIDER=mock
DEEPGRAM_API_KEY= 5629adfbe9dceee9c209461dd7c7c3fef0e0dac4
DEEPGRAM_MODEL= nova-3
DEEPGRAM_KEYTERMS=Wispr Flow,ROCm,Fireworks AI,Gemma,AMD Developer Cloud,Codex,FastAPI,SQLite
```

For real cross-browser speech-to-text, set:

```bash
STT_PROVIDER= deepgram
DEEPGRAM_API_KEY= 5629adfbe9dceee9c209461dd7c7c3fef0e0dac4
DEEPGRAM_MODEL= nova-3
```

The frontend records audio with `MediaRecorder`, which is much more portable across Chrome, Brave, Firefox, and Edge than the browser Web Speech API. The backend then owns transcription through `/api/transcribe/audio`.

Future hackathon builds can add a Gemma correction adapter behind the existing `/api/correct` endpoint. This MVP keeps LLM correction out of the running app so speech-to-text and the notepad workflow stay solid first.

## Docker

```bash
docker compose up --build
```

For publishing a Linux image from Apple Silicon:

```bash
docker buildx build --platform linux/amd64 --tag your-image:latest --push .
```

## API

- `GET /api/health`
- `POST /api/transcribe`
- `POST /api/transcribe/audio`
- `POST /api/correct`
- `GET /api/vocabulary`
- `POST /api/vocabulary`
- `GET /api/corrections`
- `POST /api/corrections`

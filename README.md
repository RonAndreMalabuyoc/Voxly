# Voxly

Voxly is a context-aware dictation app that turns rough speech transcripts into polished, accurate text using personal vocabulary and project context.

This first version is intentionally small: a focused browser dictation notepad with microphone transcription, a raw transcript view, local Ollama-powered correction with deterministic fallback rules, vocabulary editing, and SQLite-backed history.

## What Works Now

- Cross-browser microphone recording using the MediaRecorder API.
- Backend audio transcription endpoint with a provider adapter.
- Manual raw transcript fallback when no speech-to-text provider is configured.
- Notepad area for appending or replacing raw/corrected dictation.
- Local AI correction through Ollama, with rule-based fallback corrections for hackathon vocabulary:
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

Install dependencies once:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cd ../frontend
npm install
```

Run Voxly as one local app:

```bash
./scripts/run-local.sh
```

Open http://127.0.0.1:8000. FastAPI serves both the API and the built React frontend from the same server.

For frontend-only development, you can still run the backend and Vite separately:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend
npm run dev
```

Open http://localhost:5173 for the Vite dev server.

## Environment

Copy `.env.example` to `.env` for local use.

```bash
DATABASE_PATH=backend/data/voxly.db
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
STT_PROVIDER=mock
DEEPGRAM_API_KEY=
DEEPGRAM_MODEL= nova-3
CORRECTION_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:1b
```

For real cross-browser speech-to-text, set:

```bash
STT_PROVIDER= deepgram
DEEPGRAM_API_KEY=
DEEPGRAM_MODEL= nova-3
```

The frontend records audio with `MediaRecorder`, which is much more portable across Chrome, Brave, Firefox, and Edge than the browser Web Speech API. The backend then owns transcription through `/api/transcribe/audio`.
Deepgram keyterms are loaded from the SQLite vocabulary table for each recording, so terms added in the vocabulary panel affect future transcriptions without restarting the app.

For local AI correction, install Ollama, pull a model, and keep Ollama running:

```bash
ollama pull gemma3:1b
ollama run gemma3:1b
```

The `/api/correct` endpoint sends the raw transcript, context box, and SQLite vocabulary terms to Ollama. If Ollama is unavailable, Voxly falls back to deterministic correction rules so the demo still works.

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

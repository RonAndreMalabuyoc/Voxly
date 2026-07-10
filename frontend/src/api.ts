import type { CorrectionRecord, CorrectResponse, HealthResponse, VocabularyItem } from "./types";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init
  });

  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(message || `Request failed with ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

export function getHealth() {
  return request<HealthResponse>("/api/health");
}

export function getVocabulary() {
  return request<VocabularyItem[]>("/api/vocabulary");
}

export function getCorrections() {
  return request<CorrectionRecord[]>("/api/corrections");
}

export function addVocabulary(term: string, notes: string) {
  return request<VocabularyItem>("/api/vocabulary", {
    method: "POST",
    body: JSON.stringify({ term, notes })
  });
}

export function transcribeBrowserText(text: string) {
  return request<{ transcript: string; source: string }>("/api/transcribe", {
    method: "POST",
    body: JSON.stringify({ text, source: "browser" })
  });
}

export async function transcribeAudio(audio: Blob) {
  const formData = new FormData();
  formData.append("file", audio, `voxly-recording.${audio.type.includes("ogg") ? "ogg" : "webm"}`);

  const response = await fetch("/api/transcribe/audio", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(payload?.detail || `Transcription failed with ${response.status}`, response.status);
  }

  return response.json() as Promise<{
    transcript: string;
    source: string;
    transcription_engine: string;
    needs_manual_transcript: boolean;
    message: string;
  }>;
}

export function correctText(text: string, context: string) {
  return request<CorrectResponse>("/api/correct", {
    method: "POST",
    body: JSON.stringify({ text, context })
  });
}

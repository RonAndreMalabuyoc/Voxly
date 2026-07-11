import type { CorrectionRecord, CorrectResponse, DiscoveredWord, HealthResponse, VocabularyItem } from "./types";

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

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function getHealth() {
  return request<HealthResponse>("/api/health");
}

export function getVocabulary() {
  return request<VocabularyItem[]>("/api/vocabulary");
}

export function updateVocabulary(id: number, term: string, notes: string) {
  return request<VocabularyItem>(`/api/vocabulary/${id}`, {
    method: "PUT",
    body: JSON.stringify({ term, notes })
  });
}

export function deleteVocabulary(id: number) {
  return request<void>(`/api/vocabulary/${id}`, {
    method: "DELETE"
  });
}

export function getCorrections() {
  return request<CorrectionRecord[]>("/api/corrections");
}

export function getDiscoveredWords() {
  return request<DiscoveredWord[]>("/api/dictionary/discovered");
}

export function discoverWords(text: string) {
  return request<DiscoveredWord[]>("/api/dictionary/discover", {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

export function acceptDiscoveredWord(id: number, term: string, notes: string) {
  return request<VocabularyItem>(`/api/dictionary/discovered/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ term, notes })
  });
}

export function dismissDiscoveredWord(id: number) {
  return request<void>(`/api/dictionary/discovered/${id}`, {
    method: "DELETE"
  });
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

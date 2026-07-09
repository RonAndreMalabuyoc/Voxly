export type HealthResponse = {
  ok: boolean;
  correction_engine: string;
  transcription: string;
};

export type VocabularyItem = {
  id: number;
  term: string;
  notes: string;
};

export type CorrectResponse = {
  raw_text: string;
  corrected_text: string;
  correction_engine: string;
};

export {};

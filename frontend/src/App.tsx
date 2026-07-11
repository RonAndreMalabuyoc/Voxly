import { Check, Clipboard, Eraser, Flag, History, Mic, MicOff, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  acceptDiscoveredWord,
  addVocabulary,
  ApiError,
  correctText,
  deleteVocabulary,
  discoverWords,
  dismissDiscoveredWord,
  flagDiscoveredWord,
  getCorrections,
  getDiscoveredWords,
  getHealth,
  getVocabulary,
  transcribeAudio,
  transcribeBrowserText,
  updateVocabulary
} from "./api";
import type { CorrectionRecord, DiscoveredWord, HealthResponse, VocabularyItem } from "./types";

const STARTER_CONTEXT =
  "AMD Developer Hackathon ACT II project. Prefer terms like Wispr Flow, ROCm, Fireworks AI, Gemma, AMD Developer Cloud, Codex, FastAPI, and SQLite.";

type OutputMode = "append" | "replace";
type EditingVocabulary = {
  id: number;
  term: string;
  notes: string;
};
type EditingDiscovered = {
  id: number;
  term: string;
  notes: string;
};
type TranscriptReview = {
  transcript: string;
  suggestion: string;
  message: string;
};

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthCheckFailed, setHealthCheckFailed] = useState(false);
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [discoveredWords, setDiscoveredWords] = useState<DiscoveredWord[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRecord[]>([]);
  const [rawTranscript, setRawTranscript] = useState("");
  const [notepad, setNotepad] = useState("");
  const [outputMode, setOutputMode] = useState<OutputMode>("append");
  const [latestCorrected, setLatestCorrected] = useState("");
  const [context, setContext] = useState(STARTER_CONTEXT);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [capturedSegments, setCapturedSegments] = useState<string[]>([]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [micError, setMicError] = useState("");
  const [micNotice, setMicNotice] = useState("");
  const [transcriptReview, setTranscriptReview] = useState<TranscriptReview | null>(null);
  const [status, setStatus] = useState("Ready");
  const [newTerm, setNewTerm] = useState("");
  const [newNote, setNewNote] = useState("");
  const [editingVocabulary, setEditingVocabulary] = useState<EditingVocabulary | null>(null);
  const [editingDiscovered, setEditingDiscovered] = useState<EditingDiscovered | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const rawTranscriptRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);

  const supportsRecording = canRecordAudio();

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    const checkHealth = async () => {
      try {
        const result = await getHealth();
        if (cancelled) return;
        setHealth(result);
        setHealthCheckFailed(false);
        setStatus((current) => current === "Backend is not reachable yet." ? "Ready" : current);
      } catch {
        if (cancelled) return;
        setHealthCheckFailed(true);
        setStatus("Backend is not reachable yet.");
        retryTimer = window.setTimeout(checkHealth, 4000);
      }
    };

    checkHealth();
    getVocabulary().then(setVocabulary).catch(() => undefined);
    refreshDiscoveredWords();
    refreshCorrections();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => () => stopAudioMonitor(), []);

  useEffect(() => {
    if (!isListening) {
      setRecordingSeconds(0);
      return;
    }

    const interval = window.setInterval(() => {
      setRecordingSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isListening]);

  async function toggleListening() {
    if (!supportsRecording) {
      const message = "Audio recording is not available in this browser.";
      setMicError(message);
      setStatus(message);
      return;
    }

    if (isListening) {
      recorderRef.current?.stop();
    } else {
      await startRecording();
    }
  }

  async function appendRawToNotepad() {
    const result = await transcribeBrowserText(rawTranscript);
    setNotepad((current) => applyOutput(current, result.transcript, outputMode));
    setStatus(outputMode === "append" ? "Raw transcript appended" : "Notepad replaced with raw transcript");
    await scanForDiscoveredWords(result.transcript);
  }

  async function correctAndSendToNotepad() {
    if (!rawTranscript.trim()) {
      setStatus("Add or dictate a raw transcript first.");
      return;
    }

    setIsCorrecting(true);
    setStatus("Correcting with context");
    try {
      const result = await correctText(rawTranscript, context);
      setLatestCorrected(result.corrected_text);
      setNotepad((current) => applyOutput(current, result.corrected_text, outputMode));
      setStatus(outputMode === "append" ? `Corrected with ${result.correction_engine}` : `Corrected and replaced notepad`);
      await scanForDiscoveredWords(`${rawTranscript}\n${result.corrected_text}`);
      await refreshCorrections();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Correction failed");
    } finally {
      setIsCorrecting(false);
    }
  }

  async function handleAddVocabulary(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newTerm.trim()) {
      return;
    }

    await addVocabulary(newTerm, newNote);
    setVocabulary(await getVocabulary());
    await refreshDiscoveredWords();
    setNewTerm("");
    setNewNote("");
    setStatus("Vocabulary saved");
  }

  async function handleAcceptDiscovered(id: number, term?: string, notes = "") {
    const discovered = discoveredWords.find((item) => item.id === id);
    const nextTerm = term ?? discovered?.term ?? "";
    if (!nextTerm.trim()) {
      return;
    }

    try {
      await acceptDiscoveredWord(id, nextTerm, notes);
      setVocabulary(await getVocabulary());
      await refreshDiscoveredWords();
      setEditingDiscovered(null);
      const originalTerm = discovered?.term ?? "";
      const shouldUpdateTranscript = Boolean(originalTerm && originalTerm.toLowerCase() !== nextTerm.trim().toLowerCase());
      if (shouldUpdateTranscript) {
        setRawTranscript((current) => replaceApprovedTerm(current, originalTerm, nextTerm));
        setCapturedSegments((current) => current.map((segment) => replaceApprovedTerm(segment, originalTerm, nextTerm)));
      }
      setStatus(shouldUpdateTranscript ? "Added to dictionary and updated transcript" : "Added to personal dictionary");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add discovered word");
    }
  }

  async function handleDismissDiscovered(id: number) {
    await dismissDiscoveredWord(id);
    await refreshDiscoveredWords();
    setEditingDiscovered((current) => (current?.id === id ? null : current));
    setStatus("Discovery ignored");
  }

  function startEditingDiscovered(item: DiscoveredWord) {
    setEditingDiscovered({ id: item.id, term: item.term, notes: "" });
  }

  function startEditingVocabulary(item: VocabularyItem) {
    setEditingVocabulary({ id: item.id, term: item.term, notes: item.notes });
  }

  async function saveEditingVocabulary() {
    if (!editingVocabulary?.term.trim()) {
      return;
    }

    try {
      await updateVocabulary(editingVocabulary.id, editingVocabulary.term, editingVocabulary.notes);
      setVocabulary(await getVocabulary());
      setEditingVocabulary(null);
      setStatus("Dictionary term updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update dictionary term");
    }
  }

  async function handleDeleteVocabulary(id: number) {
    await deleteVocabulary(id);
    setVocabulary(await getVocabulary());
    setEditingVocabulary(null);
    setStatus("Dictionary term deleted");
  }

  async function copyNotepad() {
    await navigator.clipboard.writeText(notepad);
    setStatus("Copied notepad");
  }

  async function copyLatestCorrected() {
    await navigator.clipboard.writeText(latestCorrected);
    setStatus("Copied latest correction");
  }

  function clearRawTranscript() {
    setRawTranscript("");
    setCapturedSegments([]);
    setLatestCorrected("");
    setTranscriptReview(null);
    setMicError("");
    setMicNotice("");
    setStatus("Raw transcript cleared");
  }

  function clearNotepad() {
    setNotepad("");
    setStatus("Notepad cleared");
  }

  async function refreshCorrections() {
    try {
      setCorrections(await getCorrections());
    } catch {
      setCorrections([]);
    }
  }

  async function refreshDiscoveredWords() {
    try {
      setDiscoveredWords(await getDiscoveredWords());
    } catch {
      setDiscoveredWords([]);
    }
  }

  async function scanForDiscoveredWords(text: string) {
    if (!text.trim()) {
      return;
    }

    try {
      const discovered = await discoverWords(text);
      setDiscoveredWords(discovered);
      if (discovered.length) {
        setStatus(`${discovered.length} discovered words pending review`);
      }
    } catch {
      // Discovery should never block transcription or correction.
    }
  }

  async function flagRawSelection() {
    const term = getSelectedRawTerm(rawTranscriptRef.current);
    if (!term) {
      setStatus("Select a word in the raw transcript to flag.");
      return;
    }

    try {
      const pending = await flagDiscoveredWord(term);
      setDiscoveredWords(pending);
      const flagged = pending.find((item) => item.term.toLowerCase() === term.toLowerCase());
      if (flagged) {
        setEditingDiscovered({ id: flagged.id, term: flagged.term, notes: "" });
      }
      setStatus("Flagged for dictionary review");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not flag selected word");
    }
  }

  function applyTranscriptReview() {
    if (!transcriptReview) {
      return;
    }

    setRawTranscript((current) => replaceLastOccurrence(current, transcriptReview.transcript, transcriptReview.suggestion));
    setCapturedSegments((current) => current.map((segment) => (segment === transcriptReview.transcript ? transcriptReview.suggestion : segment)));
    setTranscriptReview(null);
    setMicNotice("Gemma suggestion applied. Edit manually if it still needs a human touch.");
    setStatus("Transcript suggestion applied");
  }

  async function copyCorrection(text: string) {
    await navigator.clipboard.writeText(text);
    setStatus("Copied correction");
  }

  async function startRecording() {
    stopAudioMonitor();
    setInterimTranscript("");
    setMicError("");
    setMicNotice("");
    setStatus("Starting recorder");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      audioChunksRef.current = [];
      mediaStreamRef.current = stream;
      recorderRef.current = recorder;
      startAudioMonitor(stream);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        void finishRecording(recorder.mimeType || mimeType || "audio/webm");
      };

      recorder.start();
      setIsListening(true);
      setStatus("Recording audio");
      setInterimTranscript("Recording. Press Stop listening when you finish speaking.");
    } catch {
      const message = "Microphone permission was blocked or unavailable.";
      setMicError(message);
      setStatus(message);
      stopAudioMonitor();
    }
  }

  async function finishRecording(mimeType: string) {
    setIsListening(false);
    stopAudioMonitor();
    setInterimTranscript("");

    const audio = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
    audioChunksRef.current = [];
    if (!audio.size) {
      setMicError("No audio was captured. Try recording again.");
      setStatus("No audio captured");
      return;
    }

    setIsTranscribing(true);
    setStatus("Uploading recording");
    setInterimTranscript("Uploading recorded audio...");

    try {
      const result = await transcribeAudio(audio, context);
      setStatus("Recording uploaded");
      setInterimTranscript("Recording uploaded. Waiting for transcript...");
      if (result.needs_manual_transcript) {
        setMicNotice(`${result.message} Type what you said below, then use Correct.`);
        setStatus("Audio captured");
        window.setTimeout(() => rawTranscriptRef.current?.focus(), 0);
        return;
      }

      const transcript = result.transcript.trim();
      if (!transcript) {
        setMicNotice("The backend did not detect any words in that recording.");
        setStatus("No transcript returned");
        return;
      }
      setRawTranscript((current) => appendText(current, transcript));
      setCapturedSegments((current) => [transcript, ...current].slice(0, 5));
      if (result.needs_review && result.review_suggestion.trim()) {
        setTranscriptReview({
          transcript,
          suggestion: result.review_suggestion.trim(),
          message: result.message || "Gemma found a possible correction."
        });
        setMicNotice(result.message || "Recording uploaded. Gemma found a possible correction.");
      } else {
        setTranscriptReview(null);
        setMicNotice("Recording uploaded and transcribed.");
      }
      setStatus(`Transcribed with ${result.transcription_engine}`);
      await scanForDiscoveredWords(transcript);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audio transcription failed.";
      if (error instanceof ApiError && error.status === 501) {
        setMicNotice(`${message} Type what you said below, then use Correct.`);
        setStatus("Audio captured");
        window.setTimeout(() => rawTranscriptRef.current?.focus(), 0);
      } else {
        setMicError(message);
        setStatus("Transcription failed");
      }
    } finally {
      setIsTranscribing(false);
      setInterimTranscript("");
    }
  }

  function startAudioMonitor(stream: MediaStream) {
    try {
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      const samples = new Uint8Array(analyser.frequencyBinCount);

      analyser.fftSize = 256;
      source.connect(analyser);
      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;

      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        const total = samples.reduce((sum, sample) => {
          const centered = (sample - 128) / 128;
          return sum + centered * centered;
        }, 0);
        const rms = Math.sqrt(total / samples.length);
        setAudioLevel(Math.min(18, Math.round(rms * 90)));
        analyserFrameRef.current = window.requestAnimationFrame(measure);
      };

      measure();
    } catch {
      setMicNotice("Input meter is unavailable here, but recording can still continue.");
    }
  }

  function stopAudioMonitor() {
    if (analyserFrameRef.current !== null) {
      window.cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setAudioLevel(0);
  }

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Voxly status">
        <div>
          <p className="eyebrow">Voxly</p>
          <h1>Dictation Notepad</h1>
        </div>
        <div className="status-strip">
          <span className={isListening ? "status-dot live" : "status-dot"} />
          <span>{status}</span>
          <span className="provider">STT: {health?.transcription ?? (healthCheckFailed ? "unavailable" : "checking")}</span>
          <span className="provider">Correction: {health?.correction_engine ?? (healthCheckFailed ? "unavailable" : "checking")}</span>
        </div>
      </section>

      <section className="workspace">
        <div className="panel capture-panel">
          <div className="panel-header">
            <div>
              <h2>Raw Transcript</h2>
              <p>{supportsRecording ? "Cross-browser audio recording is available." : "Audio recording is unavailable here."}</p>
            </div>
            <div className="panel-actions">
              <button className="icon-button" onClick={clearRawTranscript} title="Clear raw transcript" disabled={!rawTranscript.trim() && !capturedSegments.length}>
                <Eraser size={19} />
              </button>
              <button className={isListening ? "icon-button danger" : "icon-button"} onClick={toggleListening} title="Toggle microphone" disabled={isTranscribing}>
                {isListening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            </div>
          </div>

          <div className={isListening ? "mic-monitor listening" : "mic-monitor"}>
            <div className="mic-monitor-main">
              <button className={isListening ? "record-button stop" : "record-button"} onClick={toggleListening} disabled={isTranscribing}>
                {isListening ? <MicOff size={18} /> : <Mic size={18} />}
                {isListening ? "Stop listening" : isTranscribing ? "Transcribing" : "Start listening"}
              </button>
              <div className="recording-state">
                <span className="recording-label">
                  {isListening ? "Recording now" : isTranscribing ? "Transcribing audio" : "Recorder idle"}
                </span>
                <span>{formatTimer(recordingSeconds)}</span>
              </div>
            </div>

            <div className="level-meter" aria-label="Microphone input level">
              {Array.from({ length: 18 }).map((_, index) => (
                <span className={index < audioLevel ? "active" : ""} key={index} />
              ))}
            </div>

            <div className="live-transcript" aria-live="polite">
              <span>Recorder status</span>
              <p>{interimTranscript || (isListening ? "Recording audio..." : "Record audio, then Voxly will transcribe it through the backend.")}</p>
            </div>

            {micError ? <div className="mic-error">{micError}</div> : null}
            {micNotice && !micError ? <div className="mic-notice">{micNotice}</div> : null}
            {transcriptReview && !micError ? (
              <div className="review-card" aria-label="Gemma transcript review">
                <span>Gemma suggestion</span>
                <p>{transcriptReview.suggestion}</p>
                <div className="review-actions">
                  <button className="primary" onClick={applyTranscriptReview}>
                    <Check size={15} />
                    Use suggestion
                  </button>
                  <button onClick={() => setTranscriptReview(null)}>
                    <X size={15} />
                    Keep raw
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {capturedSegments.length > 0 ? (
            <div className="segment-log" aria-label="Recently captured words">
              {capturedSegments.map((segment, index) => (
                <div className="segment-item" key={`${segment}-${index}`}>
                  {segment}
                </div>
              ))}
            </div>
          ) : null}

          <textarea
            ref={rawTranscriptRef}
            value={rawTranscript}
            onChange={(event) => setRawTranscript(event.target.value)}
            placeholder="Try: I want to build a whisper flow style app using rock em and fireworks ay eye."
            aria-label="Raw transcript"
          />

          <div className="button-row">
            <div className="segmented-control" aria-label="Notepad output mode">
              <button className={outputMode === "append" ? "active" : ""} onClick={() => setOutputMode("append")}>
                Append
              </button>
              <button className={outputMode === "replace" ? "active" : ""} onClick={() => setOutputMode("replace")}>
                Replace
              </button>
            </div>
            <button onClick={appendRawToNotepad} disabled={!rawTranscript.trim()}>
              Send raw
            </button>
            <button className="primary" onClick={correctAndSendToNotepad} disabled={isCorrecting || !rawTranscript.trim()}>
              <Sparkles size={16} />
              {isCorrecting ? "Correcting" : "Correct"}
            </button>
            <button className="icon-button" onClick={flagRawSelection} title="Flag selected word for dictionary review" disabled={!rawTranscript.trim()}>
              <Flag size={17} />
            </button>
            <button className="icon-button" onClick={copyLatestCorrected} title="Copy latest corrected output" disabled={!latestCorrected.trim()}>
              <Clipboard size={18} />
            </button>
          </div>
        </div>

        <div className="panel notepad-panel">
          <div className="panel-header">
            <div>
              <h2>Notepad</h2>
              <p>Build up the final text here.</p>
            </div>
            <div className="panel-actions">
              <button className="icon-button" onClick={clearNotepad} title="Clear notepad" disabled={!notepad.trim()}>
                <Eraser size={19} />
              </button>
              <button className="icon-button" onClick={copyNotepad} title="Copy notepad" disabled={!notepad.trim()}>
                <Clipboard size={20} />
              </button>
            </div>
          </div>
          <textarea
            className="notepad"
            value={notepad}
            onChange={(event) => setNotepad(event.target.value)}
            placeholder="Corrected dictation appears here."
            aria-label="Notepad"
          />
        </div>

        <aside className="side-stack">
          <div className="panel compact-panel">
            <div className="panel-header">
              <div>
                <h2>Context</h2>
                <p>Used by the correction engine.</p>
              </div>
            </div>
            <textarea
              className="context-box"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              aria-label="Context"
            />
          </div>

          <div className="panel compact-panel">
            <div className="panel-header">
              <div>
                <h2>Personal Dictionary</h2>
                <p>{vocabulary.length} saved terms</p>
              </div>
            </div>
            <form className="vocab-form" onSubmit={handleAddVocabulary}>
              <input
                value={newTerm}
                onChange={(event) => setNewTerm(event.target.value)}
                placeholder="Term"
                aria-label="Vocabulary term"
              />
              <input
                value={newNote}
                onChange={(event) => setNewNote(event.target.value)}
                placeholder="Notes, or #no-stt to avoid speech boost"
                aria-label="Vocabulary notes"
              />
              <button className="icon-button" title="Add vocabulary term">
                <Plus size={18} />
              </button>
            </form>
            {discoveredWords.length ? (
              <div className="discovered-list" aria-label="Discovered words">
                <div className="dictionary-subhead">
                  <span>Discovered</span>
                  <span>{discoveredWords.length} pending</span>
                </div>
                {discoveredWords.map((item) => (
                  <div className="discovered-item" key={item.id}>
                    {editingDiscovered?.id === item.id ? (
                      <>
                        <input
                          value={editingDiscovered.term}
                          onChange={(event) => setEditingDiscovered((current) => (current ? { ...current, term: event.target.value } : current))}
                          aria-label="Edit discovered word"
                        />
                        <input
                          value={editingDiscovered.notes}
                          onChange={(event) => setEditingDiscovered((current) => (current ? { ...current, notes: event.target.value } : current))}
                          placeholder="Notes, or #no-stt to avoid speech boost"
                          aria-label="Discovered word notes"
                        />
                        <div className="mini-actions">
                          <button
                            className="icon-button"
                            onClick={() => handleAcceptDiscovered(item.id, editingDiscovered.term, editingDiscovered.notes)}
                            title="Add edited word to personal dictionary"
                          >
                            <Check size={15} />
                          </button>
                          <button className="icon-button" onClick={() => setEditingDiscovered(null)} title="Cancel edit">
                            <X size={15} />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span>{item.term}</span>
                        <div className="mini-actions">
                          <button className="icon-button" onClick={() => startEditingDiscovered(item)} title="Edit before adding">
                            <Pencil size={15} />
                          </button>
                          <button className="icon-button" onClick={() => handleAcceptDiscovered(item.id)} title="Add to personal dictionary">
                            <Check size={15} />
                          </button>
                          <button className="icon-button" onClick={() => handleDismissDiscovered(item.id)} title="Ignore discovered word">
                            <X size={15} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="term-list">
              {vocabulary.map((item) => (
                <div className="dictionary-item" key={`${item.id}-${item.term}`}>
                  {editingVocabulary?.id === item.id ? (
                    <>
                      <input
                        value={editingVocabulary.term}
                        onChange={(event) => setEditingVocabulary((current) => (current ? { ...current, term: event.target.value } : current))}
                        aria-label="Edit dictionary term"
                      />
                      <input
                        value={editingVocabulary.notes}
                        onChange={(event) => setEditingVocabulary((current) => (current ? { ...current, notes: event.target.value } : current))}
                        aria-label="Edit dictionary notes"
                      />
                      <div className="dictionary-actions">
                        <button className="icon-button" onClick={saveEditingVocabulary} title="Save dictionary term">
                          <Check size={15} />
                        </button>
                        <button className="icon-button" onClick={() => setEditingVocabulary(null)} title="Cancel edit">
                          <X size={15} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="dictionary-copy">
                        <span>{item.term}</span>
                        {item.notes ? <small>{item.notes}</small> : null}
                      </div>
                      <div className="dictionary-actions">
                        <button className="icon-button" onClick={() => startEditingVocabulary(item)} title="Edit dictionary term">
                          <Pencil size={15} />
                        </button>
                        <button className="icon-button" onClick={() => handleDeleteVocabulary(item.id)} title="Delete dictionary term">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="panel compact-panel history-panel">
            <div className="panel-header">
              <div>
                <h2>History</h2>
                <p>{corrections.length} recent corrections</p>
              </div>
              <History size={20} />
            </div>
            <div className="history-list">
              {corrections.length ? (
                corrections.map((item) => (
                  <article className="history-item" key={item.id}>
                    <div className="history-meta">
                      <span>{formatHistoryTime(item.created_at)}</span>
                      <span>{item.provider}</span>
                    </div>
                    <p className="history-corrected">{item.corrected_text}</p>
                    <p className="history-raw">{item.raw_text}</p>
                    <div className="history-actions">
                      <button onClick={() => setRawTranscript(item.raw_text)}>Raw</button>
                      <button onClick={() => setNotepad((current) => appendText(current, item.corrected_text))}>Append</button>
                      <button className="icon-button" onClick={() => copyCorrection(item.corrected_text)} title="Copy corrected text">
                        <Clipboard size={16} />
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="empty-state">Corrections will appear here after you use Correct.</p>
              )}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function appendText(current: string, addition: string) {
  const next = addition.trim();
  if (!next) {
    return current;
  }
  return current.trim() ? `${current.trim()}\n\n${next}` : next;
}

function applyOutput(current: string, addition: string, mode: OutputMode) {
  return mode === "replace" ? addition.trim() : appendText(current, addition);
}

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function pickRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function formatHistoryTime(value: string) {
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getSelectedRawTerm(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return "";
  }

  const value = textarea.value;
  const selection = value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
  if (selection) {
    return cleanFlaggedTerm(selection);
  }

  const before = value.slice(0, textarea.selectionStart);
  const after = value.slice(textarea.selectionStart);
  const left = before.match(/[A-Za-z0-9'_-]+$/)?.[0] ?? "";
  const right = after.match(/^[A-Za-z0-9'_-]+/)?.[0] ?? "";
  return cleanFlaggedTerm(`${left}${right}`);
}

function cleanFlaggedTerm(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").trim();
}

function replaceApprovedTerm(text: string, originalTerm: string, approvedTerm: string) {
  const original = cleanFlaggedTerm(originalTerm);
  const approved = approvedTerm.trim();
  if (!text || !original || !approved) {
    return text;
  }

  const phrasePattern = original.split(/\s+/).map(escapeRegExp).join("\\s+");
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(${phrasePattern})(?=$|[^A-Za-z0-9])`, "gi");
  return text.replace(pattern, (_match, prefix) => `${prefix}${approved}`);
}

function replaceLastOccurrence(text: string, original: string, replacement: string) {
  const index = text.lastIndexOf(original);
  if (index === -1) {
    return text;
  }
  return `${text.slice(0, index)}${replacement}${text.slice(index + original.length)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canRecordAudio() {
  return (
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export default App;

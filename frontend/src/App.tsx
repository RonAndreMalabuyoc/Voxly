import { Clipboard, Mic, MicOff, Plus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, addVocabulary, correctText, getHealth, getVocabulary, transcribeAudio, transcribeBrowserText } from "./api";
import type { HealthResponse, VocabularyItem } from "./types";

const STARTER_CONTEXT =
  "AMD Developer Hackathon ACT II project. Prefer terms like Wispr Flow, ROCm, Fireworks AI, Gemma, AMD Developer Cloud, Codex, FastAPI, and SQLite.";

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [vocabulary, setVocabulary] = useState<VocabularyItem[]>([]);
  const [rawTranscript, setRawTranscript] = useState("");
  const [notepad, setNotepad] = useState("");
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
  const [status, setStatus] = useState("Ready");
  const [newTerm, setNewTerm] = useState("");
  const [newNote, setNewNote] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const rawTranscriptRef = useRef<HTMLTextAreaElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef<number | null>(null);

  const supportsRecording = canRecordAudio();

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setStatus("Backend is not reachable yet."));
    getVocabulary().then(setVocabulary).catch(() => undefined);
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
    setNotepad((current) => appendText(current, result.transcript));
    setStatus("Raw transcript appended");
  }

  async function correctAndAppend() {
    if (!rawTranscript.trim()) {
      setStatus("Add or dictate a raw transcript first.");
      return;
    }

    setIsCorrecting(true);
    setStatus("Correcting with context");
    try {
      const result = await correctText(rawTranscript, context);
      setNotepad((current) => appendText(current, result.corrected_text));
      setStatus(`Corrected with ${result.correction_engine}`);
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

    const created = await addVocabulary(newTerm, newNote);
    setVocabulary((current) => [...current, created].sort((a, b) => a.term.localeCompare(b.term)));
    setNewTerm("");
    setNewNote("");
    setStatus("Vocabulary saved");
  }

  async function copyNotepad() {
    await navigator.clipboard.writeText(notepad);
    setStatus("Copied");
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
    setStatus("Uploading audio");
    setInterimTranscript("Transcribing recorded audio...");

    try {
      const result = await transcribeAudio(audio);
      if (result.needs_manual_transcript) {
        setMicNotice(`${result.message} Type what you said below, then use Correct + append.`);
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
      setStatus(`Transcribed with ${result.transcription_engine}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Audio transcription failed.";
      if (error instanceof ApiError && error.status === 501) {
        setMicNotice(`${message} Type what you said below, then use Correct + append.`);
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
          <span className="provider">STT: {health?.transcription ?? "checking"}</span>
          <span className="provider">Correction: {health?.correction_engine ?? "checking"}</span>
        </div>
      </section>

      <section className="workspace">
        <div className="panel capture-panel">
          <div className="panel-header">
            <div>
              <h2>Raw Transcript</h2>
              <p>{supportsRecording ? "Cross-browser audio recording is available." : "Audio recording is unavailable here."}</p>
            </div>
            <button className={isListening ? "icon-button danger" : "icon-button"} onClick={toggleListening} title="Toggle microphone" disabled={isTranscribing}>
              {isListening ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
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
            <button onClick={appendRawToNotepad} disabled={!rawTranscript.trim()}>
              Append raw
            </button>
            <button className="primary" onClick={correctAndAppend} disabled={isCorrecting || !rawTranscript.trim()}>
              <Sparkles size={16} />
              {isCorrecting ? "Correcting" : "Correct + append"}
            </button>
          </div>
        </div>

        <div className="panel notepad-panel">
          <div className="panel-header">
            <div>
              <h2>Notepad</h2>
              <p>Build up the final text here.</p>
            </div>
            <button className="icon-button" onClick={copyNotepad} title="Copy notepad" disabled={!notepad.trim()}>
              <Clipboard size={20} />
            </button>
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
                <h2>Vocabulary</h2>
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
                placeholder="Notes"
                aria-label="Vocabulary notes"
              />
              <button className="icon-button" title="Add vocabulary term">
                <Plus size={18} />
              </button>
            </form>
            <div className="term-list">
              {vocabulary.map((item) => (
                <div className="term-pill" key={item.id} title={item.notes}>
                  {item.term}
                </div>
              ))}
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

function formatTimer(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function pickRecordingMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
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

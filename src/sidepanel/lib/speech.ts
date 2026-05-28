/**
 * src/sidepanel/lib/speech.ts
 *
 * Browser-native voice dictation hook using the Web Speech API.
 * No backend required — entirely client-side.
 *
 * Usage:
 *   const speech = useSpeechRecognition((text) => setValue((v) => (v ? v + " " : "") + text));
 *
 * Transcript strategy: `onTranscript` receives ONLY newly-finalized text chunks
 * (i.e. the final transcript from each `result` event that is marked isFinal).
 * Intermediate/interim results are discarded. The caller should APPEND the chunk
 * to its existing value — no replacement needed.
 *
 * Lifecycle:
 *   - start(): sets listening=true, calls recognition.start()
 *   - stop():  sets listening=false, calls recognition.stop()
 *   - onend / onerror: sets listening=false automatically
 *   - unmount cleanup: calls recognition.stop() if still listening
 */

import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";

// ---------------------------------------------------------------------------
// Minimal type declarations for the (non-standard) Web Speech API.
// TypeScript's lib.dom.d.ts only ships SpeechRecognitionAlternative /
// SpeechRecognitionResult / SpeechRecognitionResultList — NOT the main
// SpeechRecognition interface, which Chrome exposes as webkitSpeechRecognition.
// ---------------------------------------------------------------------------

interface SpeechRecognitionResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): { transcript: string; confidence: number };
  [index: number]: { transcript: string; confidence: number };
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
}

interface SpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance extends EventTarget {
  interimResults: boolean;
  continuous: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionCtor {
  new(): SpeechRecognitionInstance;
}

// Extend Window to include the vendor-prefixed API Chrome exposes.
declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionCtor;
    SpeechRecognition?: SpeechRecognitionCtor;
  }
}

export interface SpeechApi {
  /** true when the Web Speech API is available in this browser. */
  supported: boolean;
  /** true while recognition is active (between start() and stop/onend/onerror). */
  listening: boolean;
  /** Begin speech recognition. No-op if already listening or unsupported. */
  start(): void;
  /** End speech recognition. No-op if not listening. */
  stop(): void;
}

/**
 * useSpeechRecognition
 *
 * @param onTranscript  Called with each newly-finalized transcript chunk.
 *                      Append it to the textarea value; do NOT replace.
 * @returns SpeechApi
 */
export function useSpeechRecognition(onTranscript: (text: string) => void): SpeechApi {
  const RecognitionCtor: SpeechRecognitionCtor | undefined =
    typeof window !== "undefined"
      ? (window.webkitSpeechRecognition ?? window.SpeechRecognition)
      : undefined;

  const supported = !!RecognitionCtor;
  const [listening, setListening] = useState(false);

  // Stable ref so callbacks capture the current onTranscript without
  // re-creating the recognition instance on every render.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; });

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // Lazily create (and reuse) the SpeechRecognition instance.
  function getOrCreate(): SpeechRecognitionInstance | null {
    if (!RecognitionCtor) return null;
    if (recognitionRef.current) return recognitionRef.current;

    const rec = new RecognitionCtor();
    rec.interimResults = true;
    rec.continuous = false;
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

    rec.onresult = (event: SpeechRecognitionResultEvent) => {
      // Collect all newly-finalized results from this event.
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        }
      }
      if (finalText) {
        onTranscriptRef.current(finalText);
      }
    };

    rec.onend = () => { setListening(false); };
    rec.onerror = () => { setListening(false); };

    recognitionRef.current = rec;
    return rec;
  }

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        try { rec.stop(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  function start() {
    if (!supported || listening) return;
    const rec = getOrCreate();
    if (!rec) return;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  }

  function stop() {
    const rec = recognitionRef.current;
    if (!rec || !listening) return;
    setListening(false);
    try { rec.stop(); } catch { /* ignore */ }
  }

  return { supported, listening, start, stop };
}

// Satisfy isolatedModules — the file exports real values.
// h is imported for any future JSX in this file; suppress the "unused" warning:
void h;

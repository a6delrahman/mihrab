// Voice input for every place a question is asked. Speech becomes text in
// the field; the person reviews it and sends it. Answers stay text.
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import type { Lang } from "../../../../packages/shared/src/mihrab";
import type { Strings } from "./i18n";

const LOCALE: Record<Lang, string> = { en: "en-US", de: "de-DE", ar: "ar-SA" };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
const Recognition = (): (new () => Recognition) | undefined =>
  typeof window === "undefined"
    ? undefined
    : ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export function useVoice(lang: Lang, onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const supported = !!Recognition();
  useEffect(() => () => rec.current?.abort(), []);
  function start() {
    const R = Recognition();
    if (!R) return;
    const r = new R();
    r.lang = LOCALE[lang];
    r.continuous = true;
    r.interimResults = true;
    // The whole transcript so far, final and interim parts together.
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      onText(text.trim());
    };
    r.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") setError(e.error);
    };
    r.onend = () => setListening(false);
    setError(null);
    try {
      r.start();
      rec.current = r;
      setListening(true);
    } catch {
      setListening(false);
    }
  }
  const stop = () => rec.current?.stop();
  return { supported, listening, error, toggle: () => (listening ? stop() : start()), stop };
}

// A microphone button that fills `value` through onChange while listening;
// what was typed before is kept in front of the spoken text.
export function VoiceButton(props: {
  value: string;
  onChange: (text: string) => void;
  lang: Lang;
  t: Strings;
  className?: string;
}) {
  const before = useRef("");
  const voice = useVoice(props.lang, (spoken) =>
    props.onChange(before.current ? `${before.current} ${spoken}` : spoken),
  );
  const { t } = props;
  const title = !voice.supported
    ? t.voiceUnsupported
    : voice.error === "not-allowed" || voice.error === "service-not-allowed"
      ? t.voiceBlocked
      : voice.error
        ? `${t.voiceError} (${voice.error})`
        : voice.listening
          ? t.voiceListening
          : t.voiceStart;
  return (
    <button
      type="button"
      className={`mh-voice${voice.listening ? " is-listening" : ""}${voice.error ? " is-error" : ""} ${props.className || ""}`}
      aria-label={title}
      aria-pressed={voice.listening}
      title={title}
      disabled={!voice.supported}
      onClick={() => {
        if (!voice.listening) before.current = props.value.trim();
        voice.toggle();
      }}
    >
      {voice.supported ? <Mic size={16} aria-hidden /> : <MicOff size={16} aria-hidden />}
    </button>
  );
}

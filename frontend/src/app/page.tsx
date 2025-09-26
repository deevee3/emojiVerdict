"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import styles from "./page.module.css";

const MAX_CHAR_COUNT = 500;

const EXAMPLE_PROMPTS = [
  {
    label: "Startup pitch",
    text: "Our AI gavel automates code reviews with emoji-only verdicts for teams."
  },
  {
    label: "Doomscroll detox",
    text: "This thread claims pineapple coffee cures everything in 4 emojis or less."
  },
  {
    label: "Spicy take",
    text: "CSS is just sorcery with brackets — convince my followers to believe it."
  }
];

const densityDescriptor = (value: number) => {
  if (value <= 2) return "Reserved";
  if (value <= 5) return "Balanced";
  if (value <= 8) return "Chaotic";
  return "Maximalist";
};

type VerdictStreamChunk =
  | { field: "verdict"; content: string; replace?: boolean }
  | { field: "verdict_text"; content: string; replace?: boolean }
  | { field: "sentence"; content: string; replace?: boolean }
  | { field: "sentence_text"; content: string; replace?: boolean }
  | { field: "evidence"; content: string; index?: number; replace?: boolean }
  | { field: "evidence_text"; content: string; index?: number; replace?: boolean }
  | { field: "status"; content: string }
  | { field: "share"; url: string; type: ShareLinkResult["type"] | "long" }
  | { field: "error"; message: string }
  | { field: "done" };

type EmojiLimits = {
  verdictMax: number;
  sentenceMax: number;
  evidenceEmojiMax: number;
};

type ShareLinkResult = {
  url: string;
  type: "direct" | "short";
};

const VERDICT_API_URL = process.env.NEXT_PUBLIC_VERDICT_API_URL ?? "/api/verdict";

const clampToRange = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const computeEmojiLimits = (density: number): EmojiLimits => {
  const verdictMax = clampToRange(1 + (density > 5 ? 1 : 0), 1, 3);
  const sentenceMax = clampToRange(4 + 2 * density, 4, 24);
  const evidenceEmojiMax = clampToRange(3 + density, 3, 16);
  return { verdictMax, sentenceMax, evidenceEmojiMax };
};

const clampEmojiString = (value: string, maxEmoji: number) => {
  if (maxEmoji <= 0) return "";
  const glyphs = Array.from(value);
  if (glyphs.length <= maxEmoji) {
    return value;
  }
  return glyphs.slice(0, maxEmoji).join("");
};

const sanitizeEmoji = (value: string) => value.replace(/[a-zA-Z0-9.,!?;:'"@#\-_=+`~<>/\\|]+/g, "");

const makeAbsoluteUrl = (url: string) => {
  if (typeof window === "undefined") {
    return url;
  }

  try {
    return new URL(url, window.location.origin).toString();
  } catch (error) {
    console.warn("Unable to normalize URL", { url, error });
    return url;
  }
};

const buildSharePayload = (data: {
  text: string;
  density: number;
  verdict: string;
  verdictText: string;
  sentence: string;
  sentenceText: string;
  evidence: string[];
  evidenceText: string[];
}) => {
  return {
    v: "1",
    d: data.density,
    verdict: data.verdict,
    verdict_text: data.verdictText,
    sentence: data.sentence,
    sentence_text: data.sentenceText,
    evidence: data.evidence,
    evidence_text: data.evidenceText,
    seed: crypto.randomUUID(),
    text: data.text
  } satisfies Record<string, unknown>;
};

const requestShortlink = async (payload: Record<string, unknown>): Promise<string> => {
  const response = await fetch("/api/shortlink", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("Shortlink service is unavailable. Try copying the direct link instead.");
  }

  const { url } = (await response.json()) as { url: string };
  return url;
};

const requestOgImage = async (payload: Record<string, unknown>): Promise<string> => {
  const params = new URLSearchParams();
  if (typeof window !== "undefined") {
    params.set("case", encodeURIComponent(btoa(JSON.stringify(payload))));
  }
  return `/api/og?${params.toString()}`;
};

const copyToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
};

export default function Home() {
  const [input, setInput] = useState("");
  const [density, setDensity] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string>("");
  const [sentence, setSentence] = useState<string>("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const [verdictText, setVerdictText] = useState<string>("");
  const [sentenceText, setSentenceText] = useState<string>("");
  const [evidenceText, setEvidenceText] = useState<string[]>([]);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [shareStatus, setShareStatus] = useState<string>("");
  const [shareType, setShareType] = useState<ShareLinkResult["type"] | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [ogImageUrl, setOgImageUrl] = useState<string>("");
  const [isGeneratingOg, setIsGeneratingOg] = useState(false);
  const [ogError, setOgError] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const shareHydratedRef = useRef(false);
  const activeControllerRef = useRef<AbortController | null>(null);

  const remaining = MAX_CHAR_COUNT - input.length;

  const helperText = useMemo(() => {
    if (remaining < 50) {
      return `${remaining} characters left`;
    }
    return `${MAX_CHAR_COUNT} characters max`;
  }, [remaining]);

  const emojiLimits = useMemo(() => computeEmojiLimits(density), [density]);

  useEffect(() => {
    setVerdict((prev) => clampEmojiString(prev, emojiLimits.verdictMax));
    setSentence((prev) => clampEmojiString(prev, emojiLimits.sentenceMax));
    setEvidence((prev) => prev.map((item) => clampEmojiString(item, emojiLimits.evidenceEmojiMax)));
  }, [emojiLimits]);

  useEffect(() => {
    return () => {
      activeControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (shareHydratedRef.current) {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const encodedCase = params.get("case");
    if (!encodedCase) {
      return;
    }

    try {
      const decodedJson = JSON.parse(atob(decodeURIComponent(encodedCase))) as Partial<
        ReturnType<typeof buildSharePayload>
      >;

      if (!decodedJson) {
        return;
      }

      const nextDensity = clampToRange(Number(decodedJson.d ?? density), 0, 10);

      setDensity(nextDensity);
      setInput(typeof decodedJson.text === "string" ? decodedJson.text : "");
      setVerdict(typeof decodedJson.verdict === "string" ? decodedJson.verdict : "");
      setVerdictText(
        typeof decodedJson.verdict_text === "string" ? decodedJson.verdict_text : ""
      );
      setSentence(typeof decodedJson.sentence === "string" ? decodedJson.sentence : "");
      setSentenceText(
        typeof decodedJson.sentence_text === "string" ? decodedJson.sentence_text : ""
      );
      setEvidence(
        Array.isArray(decodedJson.evidence)
          ? decodedJson.evidence.map((item) => (typeof item === "string" ? item : ""))
          : []
      );
      setEvidenceText(
        Array.isArray(decodedJson.evidence_text)
          ? decodedJson.evidence_text.map((item) => (typeof item === "string" ? item : ""))
          : []
      );

      setStatusMessage("Verdict restored from shared case file.");
      setStreamError(null);
      setIsStreaming(false);
      setShareUrl(window.location.href);
      setShareType("direct");
      setShareStatus("Share link ready.");
      setOgError(null);
      setIsGeneratingOg(false);
      setOgImageUrl(`/api/og?case=${encodedCase}`);

      shareHydratedRef.current = true;
    } catch (error) {
      console.warn("Failed to hydrate shared verdict", error);
    }
  }, [density]);

  function hasDescriptiveContent(value: string) {
    if (!value.trim()) {
      return false;
    }

    const alphanumericMatch = /[\p{L}\p{N}]/u.test(value);
    return alphanumericMatch;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasDescriptiveContent(input)) {
      setError("Add a bit of descriptive text beyond emojis to get a verdict.");
      return;
    }

    setError(null);
    setStreamError(null);
    activeControllerRef.current?.abort();

    const controller = new AbortController();
    activeControllerRef.current = controller;

    resetStreamState();
    setIsStreaming(true);
    setStatusMessage("Summoning the emoji jury...");

    void streamVerdict({ signal: controller.signal });
  }

  function handleExampleSelect(text: string) {
    setInput(text);
    setError(null);
  }

  function resetStreamState() {
    setVerdict("");
    setSentence("");
    setEvidence([]);
    setVerdictText("");
    setSentenceText("");
    setEvidenceText([]);
    setStatusMessage("");
    setShareUrl("");
    setShareStatus("");
    setShareType(null);
    setOgImageUrl("");
    setOgError(null);
  }

  async function streamVerdict({ signal }: { signal: AbortSignal }) {
    try {
      const response = await fetch(VERDICT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: input.trim(),
          density
        }),
        signal
      });

      if (!response.ok || !response.body) {
        throw new Error("Emoji court is unavailable. Please try again soon.");
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += value ?? "";

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            processStreamLine(line);
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      if (buffer.trim().length > 0) {
        processStreamLine(buffer.trim());
      }

      finalizeStream();
    } catch (caught) {
      if ((caught as Error).name === "AbortError") {
        setStatusMessage("Verdict request cancelled.");
        return;
      }

      const message =
        (caught as Error).message || "Something gummed up the gavel. Please retry shortly.";
      setStreamError(message);
      setIsStreaming(false);
      setStatusMessage("");
    }
  }

  function processStreamLine(line: string) {
    try {
      const chunk = JSON.parse(line) as VerdictStreamChunk;

      switch (chunk.field) {
        case "verdict": {
          setVerdict((prev) => {
            const base = chunk.replace ? "" : prev;
            const combined = clampEmojiString(
              sanitizeEmoji(`${base}${chunk.content}`),
              emojiLimits.verdictMax
            );
            return combined;
          });
          break;
        }
        case "verdict_text": {
          setVerdictText((prev) => (chunk.replace ? chunk.content : `${prev}${chunk.content}`));
          break;
        }
        case "sentence": {
          setSentence((prev) => {
            const base = chunk.replace ? "" : prev;
            const combined = clampEmojiString(
              sanitizeEmoji(`${base}${chunk.content}`),
              emojiLimits.sentenceMax
            );
            return combined;
          });
          break;
        }
        case "sentence_text": {
          setSentenceText((prev) => (chunk.replace ? chunk.content : `${prev}${chunk.content}`));
          break;
        }
        case "evidence": {
          const targetIndex = chunk.index ?? 0;
          setEvidence((prev) => {
            const nextEvidence = [...prev];
            const current = nextEvidence[targetIndex] ?? "";
            const base = chunk.replace ? "" : current;
            nextEvidence[targetIndex] = clampEmojiString(
              sanitizeEmoji(`${base}${chunk.content}`),
              emojiLimits.evidenceEmojiMax
            );
            return nextEvidence;
          });
          break;
        }
        case "evidence_text": {
          const targetIndex = chunk.index ?? 0;
          setEvidenceText((prev) => {
            const nextEvidence = [...prev];
            const current = nextEvidence[targetIndex] ?? "";
            const base = chunk.replace ? "" : current;
            nextEvidence[targetIndex] = `${base}${chunk.content}`.slice(0, 160);
            return nextEvidence;
          });
          break;
        }
        case "status": {
          setStatusMessage(chunk.content);
          break;
        }
        case "share": {
          void handleShareChunk(chunk);
          break;
        }
        case "error": {
          setStreamError(chunk.message);
          setIsStreaming(false);
          setStatusMessage("");
          break;
        }
        case "done": {
          finalizeStream();
          break;
        }
        default: {
          break;
        }
      }
    } catch (parseError) {
      console.warn("Unable to parse verdict stream line", parseError, line);
    }
  }

  function finalizeStream() {
    setIsStreaming(false);
    setStatusMessage((prev) => prev || "Verdict delivered.");
  }

  async function handleShareChunk(chunk: Extract<VerdictStreamChunk, { field: "share" }>) {
    const snapshot = {
      text: input.trim(),
      density,
      verdict,
      verdictText,
      sentence,
      sentenceText,
      evidence,
      evidenceText
    };

    const payload = buildSharePayload(snapshot);

    if (!mountedRef.current) {
      return;
    }

    if (chunk.type === "long") {
      setShareStatus("Generating shortlink...");
      setShareUrl("");
      setShareType(null);
    } else {
      setShareStatus("Share link ready.");
      setShareUrl(makeAbsoluteUrl(chunk.url));
      setShareType(chunk.type ?? "direct");
    }

    if (chunk.type === "long") {
      try {
        const shortUrl = await requestShortlink(payload);
        if (!mountedRef.current) {
          return;
        }

        setShareUrl(shortUrl);
        setShareType("short");
        setShareStatus("Shortlink ready.");
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }

        console.error("Shortlink generation failed", error);
        setShareStatus((error as Error).message ?? "Shortlink failed. Using direct link.");
        setShareUrl(makeAbsoluteUrl(chunk.url));
        setShareType("direct");
      }
    }

    setOgError(null);
    setIsGeneratingOg(true);
    try {
      const ogUrl = await requestOgImage(payload);
      if (!mountedRef.current) {
        return;
      }

      setOgImageUrl(ogUrl);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }

      console.error("Failed to prepare OG image", error);
      setOgError((error as Error).message ?? "Unable to prepare OG card.");
    } finally {
      if (!mountedRef.current) {
        return;
      }

      setIsGeneratingOg(false);
    }
  }

  async function handleCopyShareLink() {
    if (!shareUrl || isCopying) {
      return;
    }

    try {
      setIsCopying(true);
      await copyToClipboard(shareUrl);
      setShareStatus("Link copied to clipboard!");
      setTimeout(() => {
        setShareStatus("");
      }, 2000);
    } catch (caught) {
      setShareStatus("Copy failed. Try manually copying the link.");
      console.error("Failed to copy share link", caught);
    } finally {
      setIsCopying(false);
    }
  }

  async function handleDownloadOgCard() {
    if (!ogImageUrl || isGeneratingOg) {
      return;
    }

    try {
      setOgError(null);
      setIsGeneratingOg(true);
      const response = await fetch(ogImageUrl);
      if (!response.ok) {
        throw new Error("Failed to generate OG card. Try again.");
      }

      const imageBytes = await response.arrayBuffer();
      const pdfDoc = await PDFDocument.create();

      const contentType = response.headers.get("Content-Type") ?? "";
      let embeddedImage;

      if (contentType.includes("image/png")) {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
      } else if (contentType.includes("image/jpg") || contentType.includes("image/jpeg")) {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
      } else {
        try {
          embeddedImage = await pdfDoc.embedPng(imageBytes);
        } catch (pngError) {
          embeddedImage = await pdfDoc.embedJpg(imageBytes).catch(() => {
            throw pngError;
          });
        }
      }

      const { width, height } = embeddedImage;
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width,
        height
      });

      const pdfBytes = await pdfDoc.save();
      const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(pdfBlob);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = "emoji-verdict.pdf";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(blobUrl);
    } catch (caught) {
      setOgError((caught as Error).message ?? "Unable to download PDF.");
    } finally {
      setIsGeneratingOg(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.hero}>
          <div className={styles.brandRow}>
            <div className={styles.logoTile}>
              <Image
                src="/glenride-transparent-square256px.png"
                alt="Glenride logo"
                width={32}
                height={32}
                className={styles.logoImage}
                priority
              />
            </div>
            <span className={styles.badge}>Emoji Verdict Court</span>
          </div>
          <h1 className={styles.title}>Complete the case file and get a verdict today.</h1>
        </header>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <section className={styles.inputSection}>
            <label className={styles.label} htmlFor="verdict-text">
              Case file
            </label>
            <textarea
              id="verdict-text"
              name="verdict-text"
              value={input}
              onChange={(event) => {
                const value = event.target.value.slice(0, MAX_CHAR_COUNT);
                setInput(value);
                setError(null);
              }}
              maxLength={MAX_CHAR_COUNT}
              placeholder="Paste your spiciest take, product blurb, or viral gossip..."
              className={styles.textarea}
              aria-describedby="verdict-help"
              aria-invalid={Boolean(error)}
              rows={6}
              required
              disabled={isStreaming}
            />
            <div className={styles.helperRow}>
              <p id="verdict-help" className={styles.helperText}>
                {helperText}
              </p>
              <span className={styles.charCount} aria-live="polite">
                {input.length}/{MAX_CHAR_COUNT}
              </span>
            </div>
            {error ? (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            ) : null}
          </section>

          <section className={styles.sliderSection}>
            <div className={styles.sliderHeader}>
              <label className={styles.label} htmlFor="density">
                Weirdness / Density
              </label>
              <span className={styles.sliderDescriptor}>
                {densityDescriptor(density)} ({density})
              </span>
            </div>
            <input
              id="density"
              type="range"
              min={0}
              max={10}
              step={1}
              value={density}
              onChange={(event) => setDensity(Number(event.target.value))}
              className={styles.slider}
              aria-valuenow={density}
              aria-valuemin={0}
              aria-valuemax={10}
              disabled={isStreaming}
            />
            <p className={styles.sliderHint}>
              0 keeps the court composed; 10 unleashes maximalist emoji chaos.
            </p>
          </section>

          <section className={styles.examplesSection} aria-label="Example prompts">
            <h2 className={styles.examplesTitle}>Need inspiration?</h2>
            <div className={styles.examplesGrid}>
              {EXAMPLE_PROMPTS.map(({ label, text }) => (
                <button
                  key={label}
                  type="button"
                  className={styles.exampleButton}
                  onClick={() => handleExampleSelect(text)}
                >
                  <span className={styles.exampleLabel}>{label}</span>
                  <span className={styles.exampleText}>{text}</span>
                </button>
              ))}
            </div>
          </section>

          <div className={styles.actions}>
            <button type="submit" className={styles.submitButton} disabled={isStreaming}>
              {isStreaming ? "Awaiting verdict..." : "Request verdict"}
            </button>
            <p className={styles.disclaimer}>
              By submitting, you agree we may rewrite disallowed content with a playful warning.
            </p>
          </div>
        </form>

        <section className={styles.resultSection} aria-live="polite">
          <header className={styles.resultHeader}>
            <h2 className={styles.resultTitle}>Verdict chamber</h2>
            {statusMessage ? <p className={styles.status}>{statusMessage}</p> : null}
          </header>

          {streamError ? (
            <p role="alert" className={styles.streamError}>
              {streamError}
            </p>
          ) : null}

          <div className={styles.resultBody}>
            <div className={styles.verdictPanel}>
              <span className={styles.panelLabel}>Verdict</span>
              <p className={styles.verdictDisplay}>{verdict || (isStreaming ? "…" : "—")}</p>
              {verdictText ? (
                <p className={styles.verdictDescription}>{verdictText}</p>
              ) : null}
            </div>

            <div className={styles.evidencePanel}>
              <span className={styles.panelLabel}>Evidence</span>
              {evidence.length > 0 ? (
                <ul className={styles.evidenceList}>
                  {evidence.map((item, index) => (
                    <li key={index} className={styles.evidenceItem}>
                      <span className={styles.evidenceEmoji}>{item}</span>
                      {evidenceText[index]?.trim() ? (
                        <span className={styles.evidenceDescription}>{evidenceText[index]}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.placeholderText}>
                  {isStreaming ? "Gathering exhibits…" : "None yet"}
                </p>
              )}
            </div>

            <div className={styles.sentencePanel}>
              <span className={styles.panelLabel}>Sentence</span>
              <p className={styles.sentenceDisplay}>
                {sentence || (isStreaming ? "Drafting closing statement…" : "—")}
              </p>
              {sentenceText ? (
                <p className={styles.sentenceDescription}>{sentenceText}</p>
              ) : null}
            </div>
          </div>

          <footer className={styles.shareSection}>
            <h3 className={styles.shareTitle}>Share your verdict</h3>
            <p className={styles.shareHint}>
              Copy the link or download a PDF keepsake to show friends exactly what the jury decided.
            </p>

            <div className={styles.shareControls} role="group" aria-label="Share controls">
              <button
                type="button"
                className={styles.shareButton}
                onClick={handleCopyShareLink}
                disabled={!shareUrl || isCopying}
                aria-live="polite"
              >
                {shareUrl ? (isCopying ? "Copying…" : "Copy verdict link") : "Generate verdict first"}
              </button>

              <button
                type="button"
                className={styles.shareButtonSecondary}
                onClick={handleDownloadOgCard}
                disabled={!ogImageUrl || isGeneratingOg}
                aria-live="polite"
              >
                {isGeneratingOg ? "Preparing PDF…" : "Download verdict PDF"}
              </button>
            </div>

            {shareStatus ? (
              <p className={styles.shareStatus} role="status" aria-live="polite">
                {shareStatus}
              </p>
            ) : null}

            {shareUrl ? (
              <div className={styles.shareUrlBox}>
                <span className={styles.shareUrlLabel}>
                  {shareType === "short" ? "Shortlink" : "Direct link"}
                </span>
                <code className={styles.shareUrl} title={shareUrl}>
                  {shareUrl}
                </code>
              </div>
            ) : null}

            {ogError ? (
              <p role="alert" className={styles.streamError}>
                {ogError}
              </p>
            ) : null}
          </footer>
        </section>
      </main>
    </div>
  );
}

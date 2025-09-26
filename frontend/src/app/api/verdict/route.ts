import { randomUUID } from "crypto";

const MAX_CHAR_COUNT = 500;
const MAX_URL_LENGTH = 1900;

const encoder = new TextEncoder();

const OPENAI_MODEL = process.env.OPENAI_VERDICT_MODEL ?? "gpt-5-nano";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const clampToRange = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

const computeEmojiLimits = (density: number) => {
  const verdictMax = clampToRange(1 + (density > 5 ? 1 : 0), 1, 3);
  const sentenceMax = clampToRange(4 + 2 * density, 4, 24);
  const evidenceEmojiMax = clampToRange(3 + density, 3, 16);
  return { verdictMax, sentenceMax, evidenceEmojiMax };
};

const rateLimitStoreKey = "__emojiRateLimitStore" as const;
const globalWithStore = globalThis as typeof globalThis & {
  [rateLimitStoreKey]?: Map<string, RateLimitEntry>;
};

const rateLimitStore: Map<string, RateLimitEntry> =
  globalWithStore[rateLimitStoreKey] ?? new Map<string, RateLimitEntry>();

if (!globalWithStore[rateLimitStoreKey]) {
  globalWithStore[rateLimitStoreKey] = rateLimitStore;
}

const applyRateLimit = (identifier: string) => {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    rateLimitStore.set(identifier, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt,
      retryAfterSeconds: Math.ceil((resetAt - now) / 1000)
    };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  entry.count += 1;
  rateLimitStore.set(identifier, entry);

  return {
    allowed: true,
    remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count),
    resetAt: entry.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
};

const getClientIdentifier = (request: Request) => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || forwarded;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  return "unknown";
};

const sanitizeEmoji = (value: string) => value.replace(/[a-zA-Z0-9.,!?;:'"@#\-_=+`~<>/\\|]+/g, "");

const clampEmojiString = (value: string, maxEmoji: number) => {
  if (maxEmoji <= 0) return "";
  const glyphs = Array.from(value);
  if (glyphs.length <= maxEmoji) {
    return value;
  }
  return glyphs.slice(0, maxEmoji).join("");
};

const isEmojiOnly = (value: string) => /^[\p{Extended_Pictographic}\p{Emoji}\s]+$/u.test(value);

const parseModelJson = (content: string | null | undefined) => {
  if (!content) return null;

  const jsonFenceMatch = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = jsonFenceMatch ? jsonFenceMatch[1] : content;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

type ResponsesJSON = {
  output?: { content?: { text?: string }[] }[];
};

type ModerationResult = {
  action: "allow" | "rewrite" | "block";
  reason?: string;
  safeText?: string;
};

type VerdictPromptPayload = {
  text: string;
  density: number;
  limits: ReturnType<typeof computeEmojiLimits>;
};

type VerdictModelOutput = {
  verdict: string;
  verdict_text: string;
  sentence: string;
  sentence_text: string;
  evidence: string[];
  evidence_text: string[];
  status_advice: string;
};

const extractFirstJsonString = (data: ResponsesJSON): string | null => {
  const text = data.output?.[0]?.content?.[0]?.text;
  return typeof text === "string" ? text : null;
};

const moderateCase = async (text: string): Promise<ModerationResult> => {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI credentials are not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      input: `Assess the following text for content policy compliance. Respond with JSON {"action":"allow|rewrite|block","reason":"friendly public message","safe_text":"optional rewritten text"}. Use "rewrite" when a playful warning should replace unsafe details. Use "block" only for extreme violence, hate, or disallowed content. Preserve or add appropriate emoji in safe_text.\n\n${JSON.stringify(
        text
      )}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Moderation request failed: ${errorText}`);
  }

  const data = (await response.json()) as ResponsesJSON;
  const jsonString = extractFirstJsonString(data);

  if (!jsonString) {
    return { action: "allow" };
  }

  try {
    const parsed = JSON.parse(jsonString) as ModerationResult;
    if (parsed.action === "rewrite" && typeof parsed.safeText !== "string") {
      parsed.safeText = text;
    }
    return {
      action: parsed.action ?? "allow",
      reason: parsed.reason,
      safeText: parsed.safeText
    };
  } catch {
    return { action: "allow" };
  }
};

const createPrompt = ({
  text,
  density,
  limits
}: VerdictPromptPayload) => {
  const { verdictMax, sentenceMax, evidenceEmojiMax } = limits;

  return [
    {
      role: "system" as const,
      content:
        "You are the presiding judge of the Emoji Verdict Court. Respond only with valid JSON matching the schema and instructions."
    },
    {
      role: "user" as const,
      content: `\
Evaluate the following text and respond with playful emoji-only outcomes.\n\nTEXT (max ${MAX_CHAR_COUNT} chars):\n${text}\n\nRules:\n- Provide a JSON object with keys: verdict (emoji string), verdict_text (text string), sentence (emoji string), sentence_text (text string), evidence (array of emoji strings), evidence_text (array of text strings), status_advice (string).\n- verdict: ${verdictMax} emoji max, single phrase summarizing outcome.\n- verdict_text: 1 short sentence (<=120 chars) describing the meaning of the verdict in plain language.\n- sentence: ${sentenceMax} emoji max, sequence conveying the "punishment".\n- sentence_text: 1 short sentence (<=120 chars) describing the sentence in plain language.\n- evidence: array of emoji strings, each ${evidenceEmojiMax} emoji max, target 3 entries.\n- evidence_text: array of sentences (<=120 chars each) explaining the matching evidence item. Length must equal evidence array length.\n- status_advice: short textual tip in <= 80 characters, ASCII only.\n- Emoji strings must contain only emoji glyphs (no letters, numbers, punctuation).\n- Tailor emoji density & weirdness to slider value ${density} on scale 0-10.\n- Keep tone whimsical but safe-for-work.\n- If content is harmful/NSFW, rewrite to a safe playful warning using emoji for the verdict/sentence/evidence.\n- Return strictly JSON with double quotes, no explanations.`
    }
  ];
};

const detectLanguage = async (text: string): Promise<string> => {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI credentials are not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      input: `Provide JSON {"language":"<iso-639-1>"} representing the dominant language of this text. Preserve emoji as-is.\n\n${JSON.stringify(
        text
      )}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Language detection failed: ${errorText}`);
  }

  const data = (await response.json()) as ResponsesJSON;
  const jsonString = extractFirstJsonString(data);

  if (!jsonString) {
    return "en";
  }

  try {
    const parsed = JSON.parse(jsonString) as { language?: string };
    const code = typeof parsed.language === "string" ? parsed.language.toLowerCase() : "en";
    return code || "en";
  } catch {
    return "en";
  }
};

const translateText = async ({
  text,
  sourceLanguage,
  targetLanguage
}: {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}): Promise<{ translated: string; wasTranslated: boolean }> => {
  if (sourceLanguage === targetLanguage || !text.trim()) {
    return { translated: text, wasTranslated: false };
  }

  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI credentials are not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5-nano",
      input: `Translate the following text from ${sourceLanguage} to ${targetLanguage}. Preserve emoji content exactly. Respond with JSON {"text":"..."}.\n\n${JSON.stringify(
        text
      )}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Translation failed: ${errorText}`);
  }

  const data = (await response.json()) as ResponsesJSON;
  const jsonString = extractFirstJsonString(data);

  if (!jsonString) {
    return { translated: text, wasTranslated: false };
  }

  try {
    const parsed = JSON.parse(jsonString) as { text?: string };
    const translated = typeof parsed.text === "string" ? parsed.text : text;
    return { translated, wasTranslated: translated !== text };
  } catch {
    return { translated: text, wasTranslated: false };
  }
};

const fetchChatCompletion = async (
  requestBody: Record<string, unknown>,
  attemptedTemperatureFallback = false
): Promise<unknown> => {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (response.ok) {
    return (await response.json()) as unknown;
  }

  const errorText = await response.text();
  let parsedError: { error?: { message?: string; code?: string } } | null = null;

  try {
    parsedError = JSON.parse(errorText) as { error?: { message?: string; code?: string } };
  } catch {
    parsedError = null;
  }

  const errorMessage = parsedError?.error?.message;
  const errorCode = parsedError?.error?.code;
  const hasTemperature = Object.prototype.hasOwnProperty.call(requestBody, "temperature");

  if (
    !attemptedTemperatureFallback &&
    hasTemperature &&
    typeof errorMessage === "string" &&
    errorMessage.toLowerCase().includes("temperature") &&
    errorCode === "unsupported_value"
  ) {
    const withoutTemperature = { ...requestBody };
    delete withoutTemperature.temperature;
    console.warn("Retrying OpenAI request without temperature due to model limitations.");
    return fetchChatCompletion(withoutTemperature, true);
  }

  throw new Error(`OpenAI request failed: ${errorText}`);
};

const fetchVerdict = async (payload: VerdictPromptPayload) => {
  if (!OPENAI_API_KEY) {
    throw new Error("OpenAI credentials are not configured.");
  }

  const prompt = createPrompt(payload);
  const requestBody: Record<string, unknown> = {
    model: OPENAI_MODEL,
    messages: prompt
  };

  if (!OPENAI_MODEL.includes("gpt-5-nano")) {
    requestBody.temperature = clampToRange(payload.density / 10, 0.2, 0.9);
  }

  const data = (await fetchChatCompletion(requestBody)) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content ?? null;
  return parseModelJson(content) as VerdictModelOutput | null;
};

const validateModelOutput = (
  result: unknown,
  limits: ReturnType<typeof computeEmojiLimits>
): {
  verdict: string;
  verdictText: string;
  sentence: string;
  sentenceText: string;
  evidence: string[];
  evidenceText: string[];
  statusAdvice: string;
} => {
  if (!result || typeof result !== "object") {
    throw new Error("Model returned empty response.");
  }

  const data = result as Record<string, unknown>;

  const verdictRaw = data.verdict;
  const verdictTextRaw = data.verdict_text;
  const sentenceRaw = data.sentence;
  const sentenceTextRaw = data.sentence_text;
  const evidenceRaw = data.evidence;
  const evidenceTextRaw = data.evidence_text;
  const statusAdviceRaw = data.status_advice;

  const verdict = typeof verdictRaw === "string" ? sanitizeEmoji(verdictRaw.trim()) : "";
  const verdictText =
    typeof verdictTextRaw === "string" ? verdictTextRaw.trim().slice(0, 160) : "";
  const sentence = typeof sentenceRaw === "string" ? sanitizeEmoji(sentenceRaw.trim()) : "";
  const sentenceText =
    typeof sentenceTextRaw === "string" ? sentenceTextRaw.trim().slice(0, 160) : "";
  const evidenceArray = Array.isArray(evidenceRaw) ? evidenceRaw : [];
  const evidenceTextArray = Array.isArray(evidenceTextRaw) ? evidenceTextRaw : [];
  const statusAdvice =
    typeof statusAdviceRaw === "string"
      ? statusAdviceRaw.trim().slice(0, 80)
      : "Share responsibly.";

  if (!verdict || !isEmojiOnly(verdict)) {
    throw new Error("Model verdict missing or not emoji-only.");
  }

  if (!verdictText) {
    throw new Error("Model verdict_text missing or empty.");
  }

  if (!sentence || !isEmojiOnly(sentence)) {
    throw new Error("Model sentence missing or not emoji-only.");
  }

  if (!sentenceText) {
    throw new Error("Model sentence_text missing or empty.");
  }

  const evidenceStrings = evidenceArray.filter((item): item is string => typeof item === "string");

  const evidence: string[] = [];
  for (const entry of evidenceStrings) {
    const sanitized = sanitizeEmoji(entry.trim());
    if (sanitized.length === 0) {
      continue;
    }

    if (!isEmojiOnly(sanitized)) {
      continue;
    }

    evidence.push(sanitized);

    if (evidence.length >= 6) {
      break;
    }
  }

  if (evidence.length === 0) {
    throw new Error("Model evidence missing or invalid.");
  }

  const evidenceText: string[] = [];
  evidenceTextArray.forEach((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      evidenceText.push(entry.trim().slice(0, 160));
    }
  });

  if (evidenceText.length !== evidence.length) {
    throw new Error("Model evidence_text length mismatch.");
  }

  return {
    verdict: clampEmojiString(verdict, limits.verdictMax),
    verdictText,
    sentence: clampEmojiString(sentence, limits.sentenceMax),
    sentenceText,
    evidence: evidence.map((item) => clampEmojiString(item, limits.evidenceEmojiMax)),
    evidenceText,
    statusAdvice
  };
};

const createSharePayload = (
  text: string,
  density: number,
  validated: ReturnType<typeof validateModelOutput>
) => ({
  v: "1",
  d: density,
  verdict: validated.verdict,
  verdict_text: validated.verdictText,
  sentence: validated.sentence,
  sentence_text: validated.sentenceText,
  evidence: validated.evidence,
  evidence_text: validated.evidenceText,
  seed: randomUUID(),
  text
});

const encodeSharePayload = (payload: Record<string, unknown>) =>
  encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString("base64"));

const createDirectShareUrl = (payload: Record<string, unknown>) => {
  const params = new URLSearchParams();
  params.set("case", encodeSharePayload(payload));
  return `/?${params.toString()}`;
};

const createStatusEvent = (content: string) => ({
  field: "status" as const,
  content
});

const createErrorEvent = (message: string) => ({
  field: "error" as const,
  message
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  const sendInvalid = (message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: {
        "Content-Type": "application/json"
      }
    });

  if (!body || typeof body !== "object") {
    return sendInvalid("Invalid JSON body.");
  }

  const { text, density } = body as {
    text?: unknown;
    density?: unknown;
  };

  if (typeof text !== "string") {
    return sendInvalid("Field 'text' is required.");
  }

  if (text.length === 0 || text.trim().length === 0) {
    return sendInvalid("Provide descriptive text for a verdict.");
  }

  if (text.length > MAX_CHAR_COUNT) {
    return sendInvalid(`Text exceeds ${MAX_CHAR_COUNT} character limit.`);
  }

  const parsedDensity = typeof density === "number" ? density : Number(density);
  if (Number.isNaN(parsedDensity)) {
    return sendInvalid("Density must be numeric between 0 and 10.");
  }

  const clampedDensity = clampToRange(parsedDensity, 0, 10);
  const limits = computeEmojiLimits(clampedDensity);
  const clientIdentifier = getClientIdentifier(request);

  const rateLimit = applyRateLimit(clientIdentifier);
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({
        error:
          "Our emoji docket is jam-packed for today! Please come back tomorrow with fresh takes.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
        remaining: rateLimit.remaining
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": rateLimit.retryAfterSeconds.toString()
        }
      }
    );
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      };

      const closeWithError = (message: string) => {
        enqueue(createErrorEvent(message));
        controller.close();
      };

      try {
        enqueue(createStatusEvent("Reviewing case file..."));

        const moderation = await moderateCase(text);

        if (moderation.action === "block") {
          const blockMessage =
            moderation.reason ??
            "⚖️ Case dismissed: this submission breaks the Emoji Court rulebook.";
          closeWithError(blockMessage);
          return;
        }

        let moderatedText = text;
        if (moderation.action === "rewrite" && moderation.safeText) {
          moderatedText = moderation.safeText;
          enqueue(
            createStatusEvent(
              moderation.reason ??
                "Content was rewritten into a playful warning to keep things court-approved."
            )
          );
        }

        let detectedLanguage = "en";
        let translatedText = moderatedText;
        let wasTranslated = false;

        try {
          detectedLanguage = await detectLanguage(moderatedText);
          const translation = await translateText({
            text: moderatedText,
            sourceLanguage: detectedLanguage,
            targetLanguage: "en"
          });

          translatedText = translation.translated;
          wasTranslated = translation.wasTranslated;

          if (wasTranslated) {
            enqueue(
              createStatusEvent(
                `Translated from ${detectedLanguage.toUpperCase()} for consistent emoji verdict.`
              )
            );
          }
        } catch (languageError) {
          console.error("Language handling failed", languageError);
          enqueue(
            createStatusEvent(
              "Language services unavailable. Proceeding with original wording."
            )
          );
          detectedLanguage = "en";
          translatedText = moderatedText;
          wasTranslated = false;
        }

        const verdictResult = await fetchVerdict({
          text: translatedText,
          density: clampedDensity,
          limits
        });

        if (!verdictResult) {
          closeWithError("Emoji court could not render a verdict. Try again.");
          return;
        }

        let validated: ReturnType<typeof validateModelOutput>;

        try {
          validated = validateModelOutput(verdictResult, limits);
        } catch (validationError) {
          closeWithError(
            (validationError as Error).message ||
              "Verdict formatting failed validation. Please resubmit."
          );
          return;
        }

        enqueue(createStatusEvent("Finalizing verdict scroll..."));
        enqueue({ field: "verdict", content: validated.verdict, replace: true });
        enqueue({ field: "verdict_text", content: validated.verdictText, replace: true });
        enqueue({ field: "sentence", content: validated.sentence, replace: true });
        enqueue({ field: "sentence_text", content: validated.sentenceText, replace: true });

        validated.evidence.forEach((item, index) => {
          enqueue({ field: "evidence", index, content: item, replace: true });
        });

        validated.evidenceText.forEach((item, index) => {
          enqueue({ field: "evidence_text", index, content: item, replace: true });
        });

        enqueue(createStatusEvent(validated.statusAdvice));

        try {
          const sharePayload = createSharePayload(
            moderatedText.trim(),
            clampedDensity,
            validated
          );

          const directUrl = createDirectShareUrl(sharePayload);

          if (directUrl.length <= MAX_URL_LENGTH) {
            enqueue({ field: "share", url: directUrl, type: "direct" });
          } else {
            enqueue({ field: "share", url: directUrl, type: "long" });
          }
        } catch (shareError) {
          enqueue(
            createStatusEvent(`Share payload warning: ${(shareError as Error).message}`)
          );
        }

        enqueue({ field: "done" });
        controller.close();
      } catch (error) {
        closeWithError(
          (error as Error).message ||
            "The emoji jury hung mid-trial. Please try resubmitting your case."
        );
      }
    }
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

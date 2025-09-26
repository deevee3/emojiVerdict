import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";

export const runtime = "edge";

const WIDTH = 1200;
const HEIGHT = 630;

type OgPayload = {
  verdict?: string;
  sentence?: string;
  evidence?: string[];
  d?: number;
  text?: string;
};

const decodePayload = (encoded: string): OgPayload | null => {
  try {
    const decodedBase64 = decodeURIComponent(encoded);
    const jsonString = typeof atob === "function"
      ? atob(decodedBase64)
      : Buffer.from(decodedBase64, "base64").toString("utf-8");
    return JSON.parse(jsonString) as OgPayload;
  } catch (error) {
    console.warn("Failed to decode OG payload", error);
    return null;
  }
};
const formatEvidence = (items: string[] | undefined) => {
  if (!items || items.length === 0) {
    return ["No exhibits submitted"];
  }

  return items.slice(0, 3).map((item, index) => `${index + 1}. ${item || "—"}`);
};

const densityDescriptor = (density: number | undefined) => {
  if (density === undefined || Number.isNaN(density)) {
    return "Balanced";
  }

  if (density <= 2) return "Reserved";
  if (density <= 5) return "Balanced";
  if (density <= 8) return "Chaotic";
  return "Maximalist";
};

const truncateText = (value: string | undefined, max = 160) => {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
};

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const encoded = searchParams.get("case");

  if (!encoded) {
    return new Response("Missing case payload", { status: 400 });
  }

  const payload = decodePayload(encoded);

  if (!payload) {
    return new Response("Invalid case payload", { status: 400 });
  }

  const verdict = payload.verdict || "⚖️ Pending";
  const evidence = formatEvidence(payload.evidence);
  const sentence = payload.sentence || "Awaiting sentencing";
  const density = densityDescriptor(typeof payload.d === "number" ? payload.d : undefined);
  const caseText = truncateText(payload.text, 160);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background: "linear-gradient(135deg, #0f172a 0%, #312e81 60%, #6d28d9 100%)",
          color: "#f9fafb",
          fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <span
            style={{
              fontSize: 24,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              opacity: 0.7
            }}
          >
            Emoji Verdict Court
          </span>
          <span style={{ fontSize: 48, fontWeight: 700 }}>Verdict</span>
          <span style={{ fontSize: 84, lineHeight: 1.1 }}>{verdict}</span>
        </header>

        <section style={{ display: "flex", gap: "36px" }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              background: "rgba(15, 23, 42, 0.75)",
              borderRadius: "32px",
              padding: "32px"
            }}
          >
            <span style={{ fontSize: 28, fontWeight: 600, textTransform: "uppercase" }}>
              Evidence
            </span>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                fontSize: 40
              }}
            >
              {evidence.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>

          <div
            style={{
              width: "38%",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              background: "rgba(15, 23, 42, 0.75)",
              borderRadius: "32px",
              padding: "32px"
            }}
          >
            <span style={{ fontSize: 28, fontWeight: 600, textTransform: "uppercase" }}>
              Sentence
            </span>
            <span style={{ fontSize: 46, lineHeight: 1.2 }}>{sentence}</span>
          </div>
        </section>

        <footer
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 24,
            opacity: 0.85
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <span>Density: {density}</span>
            {caseText ? (
              <span style={{ fontSize: 20, opacity: 0.75 }}>Case file: {caseText}</span>
            ) : null}
          </div>
          <span style={{ fontSize: 24 }}>emoji.court</span>
        </footer>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "Cache-Control": "public, max-age=86400"
      }
    }
  );
}

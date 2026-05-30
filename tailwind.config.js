/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/sidepanel/**/*.{ts,tsx,html,css}",
    "./src/options/**/*.{ts,tsx,html,css}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      animation: {
        "spin-slow": "spin 3s linear infinite",
        "pulse-fast": "pulse 0.75s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "bubble-in": "bubble-in 0.28s cubic-bezier(.22,1,.36,1) both",
        "glow-pulse": "glow-pulse 2.5s ease-in-out infinite",
      },
      keyframes: {
        "bubble-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.96)" },
          to: { opacity: "1", transform: "none" },
        },
        "glow-pulse": {
          "0%, 100%": { opacity: "0.6", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.08)" },
        },
      },
    },
  },
  plugins: [],
};

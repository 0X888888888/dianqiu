/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
  theme: {
    extend: {
      colors: {
        bg: "#0A0D0A",
        surface: "#121A12",
        "surface-2": "#1B241B",
        primary: "#22C55E",
        "primary-hover": "#16A34A",
        danger: "#EF4444",
        "danger-hover": "#DC2626",
        accent: "#FACC15",
        muted: "#9CA3AF",
        border: "#273227",
        "border-bright": "#3A4D3A",
      },
      borderRadius: {
        DEFAULT: "2px",
        sm: "2px",
        md: "4px",
        lg: "6px",
      },
      fontFamily: {
        display: ["Bebas Neue", "Impact", "sans-serif"],
        body: ["IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

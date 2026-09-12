/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./tracking_worker.js",
    "./scripts/**/*.mjs"
  ],
  safelist: [
    'show',
    'hide',
    'locked',
    'active',
    'ar-ready-hud',
    'fade-out',
    'camera-welcome-blur',
    'camera-unblurring',
    'status-dot',
    'reduced-quality',
    'ui-btn-primary',
    'ui-btn-secondary'
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#F16B25', // Signature ss3 vibrant rust orange
          hover: '#FF7E3E',
          active: '#E05A18',
          subtle: 'rgba(241, 107, 37, 0.12)'
        },
        dark: {
          base: '#141519',    // ss3 deep matte obsidian background
          card: '#1E2028',    // ss3 elevated card background
          elevated: '#252833',// ss3 higher elevation card / input
          border: 'rgba(255, 255, 255, 0.08)',
          borderHighlight: 'rgba(241, 107, 37, 0.4)',
          muted: '#8E929E',   // ss3 slate secondary text
          text: '#FFFFFF'
        }
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'card': '0 12px 36px -8px rgba(0, 0, 0, 0.65), 0 4px 16px -4px rgba(0, 0, 0, 0.5)',
        'orange-glow': '0 8px 24px rgba(241, 107, 37, 0.35)',
        'orange-glow-lg': '0 12px 32px rgba(241, 107, 37, 0.45)',
      }
    }
  },
  plugins: []
};

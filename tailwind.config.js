/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Institutional palette. Navy carries the sidebar and report headings;
        // cool blue is the single accent used for primary actions and links.
        navy: {
          50: '#f3f5f9',
          100: '#e3e8f0',
          200: '#c7d0e0',
          300: '#9daecb',
          400: '#6c83ab',
          500: '#4c6490',
          600: '#3a4e75',
          700: '#2f3f5e',
          800: '#1e2a42',
          900: '#141d30',
          950: '#0c1320',
        },
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        // Amounts, account codes and document numbers are tabular by nature.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        raised: '0 4px 12px -2px rgb(16 24 40 / 0.08), 0 2px 6px -2px rgb(16 24 40 / 0.05)',
      },
      gridTemplateColumns: {
        jev: 'minmax(9rem,1fr) minmax(12rem,2fr) minmax(8rem,1fr) minmax(8rem,1fr) 2.5rem',
      },
    },
  },
  plugins: [],
};

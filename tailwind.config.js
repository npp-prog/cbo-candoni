/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * Patch 167 - the palette of the CFMS mark (public/icon-512.png):
         *   navy  #014282  the circle            -> navy-700
         *   blue  #0199e7  the inner bracket     -> brand-500
         *   cyan  #01d8d8, teal #03ecc1, green #95f882  the three bars -> accent
         * Navy carries the sidebar, headings and text; blue is the accent for
         * primary actions and links; the bars' teal is the "done / success"
         * colour. Each scale is built around the mark's colour so a button's
         * white label keeps at least 4.5:1 contrast (brand-600, accent-600).
         */
        navy: {
          50: '#eef4fb',
          100: '#d7e5f5',
          200: '#b0cbeb',
          300: '#7ea9dc',
          400: '#4a82c6',
          500: '#2563a8',
          600: '#0f5195',
          700: '#014282',
          800: '#02366b',
          900: '#032a54',
          950: '#021a36',
        },
        brand: {
          50: '#e8f6fe',
          100: '#cdeefc',
          200: '#9fdcf9',
          300: '#63c3f3',
          400: '#27aaed',
          500: '#0199e7',
          600: '#0177b5',
          700: '#015d8f',
          800: '#024c75',
          900: '#033f61',
        },
        accent: {
          50: '#e6fdf8',
          100: '#c3faee',
          200: '#8af4dc',
          300: '#4beec9',
          400: '#03ecc1',
          500: '#02c4a1',
          600: '#027a65',
          700: '#026656',
          800: '#025245',
          900: '#024136',
        },
        /* The mark's own colours, for the places that draw it. */
        mark: {
          navy: '#014282',
          blue: '#0199e7',
          cyan: '#01d8d8',
          teal: '#03ecc1',
          green: '#95f882',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        /*
         * Amounts, account codes and document numbers. Patch 168: Inter with
         * tabular (equal-width) figures instead of a monospaced face - the
         * figures still line up in columns, and a zero is a plain 0, with no
         * dot or slash inside (JetBrains Mono drew it dotted).
         */
        mono: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
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

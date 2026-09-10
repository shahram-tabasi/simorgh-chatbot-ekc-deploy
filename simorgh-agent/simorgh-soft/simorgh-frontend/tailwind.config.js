export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      // `font-sans` is what Tailwind's own preflight puts on the page and what
      // a handful of components ask for by name, so pointing it at the stack in
      // src/fonts.css gives every existing class the Persian faces without a
      // single component having to change.
      fontFamily: {
        sans: ['var(--simorgh-font-fa)'],
      },
    },
  },
}

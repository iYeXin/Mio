export default {
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    watch: {
      ignored: ["**/.mio/**", "**/build/**", "**/dist/**", "**/artifacts/**", "**/.cache/**", "**/*.apk", "**/*.zip"],
    },
  },
};

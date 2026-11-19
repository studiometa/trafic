/** Vite inlines a `?raw` import as the text of the file. */
declare module "*?raw" {
  const content: string;
  export default content;
}

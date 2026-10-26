/** Where the font pickers get the installed fonts and the preview of a bundled one. Write's own window supplies them; a host page (Cadrel's Admin) swaps in its own. */
export const fontService = {
  installed: (): Promise<string[]> => window.cadrelWrite.listInstalledFonts(),
  preview: (family: string): Promise<string | null> => window.cadrelWrite.bundledFontPreview(family)
};

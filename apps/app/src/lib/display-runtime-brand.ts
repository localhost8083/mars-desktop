/** Presentation-only name for text supplied by the local agent runtime. */
export function displayRuntimeBrand(value: string): string {
  return value.replace(/opencode/gi, (name) => {
    if (name === name.toUpperCase()) return "MARS"
    if (name[0] === name[0]?.toUpperCase()) return "Mars"
    return "mars"
  })
}

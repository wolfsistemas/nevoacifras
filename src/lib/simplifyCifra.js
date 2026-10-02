// Simplificação de acordes usada como alternativa local quando o Cifra Club
// não libera a versão simplificada oficial. Mantém a fundamental e a qualidade
// maior/menor, removendo extensões (7, 9, 11, 13, sus, add, dim, aug...) e o
// baixo invertido. Ex.: G4/B -> G, Am7 -> Am, F9 -> F, G/B -> G.
export function simplifyChordName(name) {
  const raw = String(name || '').trim()
  if (!raw) return raw
  if (/^n\.?c\.?$/i.test(raw)) return raw
  const m = raw.match(/^([A-G][#b]?)/)
  if (!m) return raw
  const root = m[1]
  const rest = raw.slice(root.length)
  const minor = /^m(?!aj)/.test(rest) ? 'm' : ''
  return `${root}${minor}`
}

export function simplifyCifraLines(lines) {
  if (!Array.isArray(lines)) return []
  return lines.map((l) => {
    if (!l || typeof l !== 'object') return l
    if (l.kind === 'verse') {
      const chordAt = (l.chordAt || []).map((c) => ({
        ...c,
        names: (c.names || []).map(simplifyChordName)
      }))
      return { ...l, chordAt }
    }
    if (l.kind === 'chords') {
      const original = l.chords || []
      const chords = original.map(simplifyChordName)
      let text = l.text || ''
      for (const c of original) text = text.replace(c, simplifyChordName(c))
      return { ...l, chords, text }
    }
    return l
  })
}

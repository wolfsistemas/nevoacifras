import { parseChord, mod12, noteName } from './transpose'

// Escalas (graus em semitons a partir da tônica) e a qualidade esperada de cada grau.
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]
const MAJOR_QUAL = ['maj', 'm', 'm', 'maj', 'maj', 'm', 'dim']
const MINOR_QUAL = ['m', 'dim', 'maj', 'm', 'm', 'maj', 'maj']

// Reduz a qualidade do acorde a três famílias para comparar com a escala.
function triadClass(quality) {
  const q = String(quality || '')
  if (/dim|°|ø|o7$/i.test(q)) return 'dim'
  if (/^m(?!aj)|^min|^-/.test(q)) return 'm'
  return 'maj'
}

// Extrai os acordes, em ordem, de uma cifra já parseada (linhas do CifraView).
export function songChords(lines) {
  const out = []
  for (const line of lines || []) {
    if (!line) continue
    if (line.kind === 'chords' && Array.isArray(line.chords)) {
      out.push(...line.chords)
    } else if (line.kind === 'verse' && Array.isArray(line.chordAt)) {
      for (const at of line.chordAt) {
        if (Array.isArray(at.names)) out.push(...at.names)
      }
    }
  }
  return out
}

// Descobre o tom mais provável da música: percorre as 24 tonalidades e escolhe
// a que melhor explica os acordes, com bônus para o primeiro e o último acorde.
export function detectKey(lines) {
  const parsed = songChords(lines)
    .map(parseChord)
    .filter(Boolean)
  if (!parsed.length) return null

  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  let best = null

  for (const mode of ['major', 'minor']) {
    const steps = mode === 'major' ? MAJOR_STEPS : MINOR_STEPS
    const quals = mode === 'major' ? MAJOR_QUAL : MINOR_QUAL
    const tonicQual = mode === 'major' ? 'maj' : 'm'
    for (let root = 0; root < 12; root++) {
      let score = 0
      for (const chord of parsed) {
        const idx = steps.indexOf(mod12(chord.semitone - root))
        if (idx === -1) continue
        score += 1
        if (triadClass(chord.quality) === quals[idx]) score += 0.6
      }
      if (mod12(first.semitone) === root && triadClass(first.quality) === tonicQual) score += 4
      if (mod12(last.semitone) === root && triadClass(last.quality) === tonicQual) score += 2.5
      if (!best || score > best.score) best = { root, mode, score }
    }
  }
  return best
}

// Nome do tom detectado (ex.: "G", "Am"), ou null se não der para detectar.
export function detectKeyName(lines) {
  const k = detectKey(lines)
  if (!k) return null
  return noteName(k.root) + (k.mode === 'minor' ? 'm' : '')
}

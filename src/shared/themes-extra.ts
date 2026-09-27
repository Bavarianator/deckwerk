// Premium-Themes (Phase 3). Nur Typ-Import aus ./themes, damit themes.ts diese Datei zyklusfrei einbinden kann.
import type { FontRef, Theme } from './themes'

const Arial: FontRef = { css: 'Arimo', pptx: 'Arial' }
const Calibri: FontRef = { css: 'Carlito', pptx: 'Calibri' }
const Georgia: FontRef = { css: 'Gelasio', pptx: 'Georgia' }
// Premium-Schriften (TTF in assets/fonts, werden in die PPTX eingebettet). Gleiche Werte wie FONTS in themes.ts;
// hier dupliziert, weil themes.ts diese Datei importiert (Zyklus).
const Fraunces: FontRef = { css: 'Fraunces', pptx: 'Fraunces', embed: 'Fraunces', serif: true }
const Manrope: FontRef = { css: 'Manrope', pptx: 'Manrope', embed: 'Manrope' }
const SpaceGrotesk: FontRef = { css: 'Space Grotesk', pptx: 'Space Grotesk', embed: 'SpaceGrotesk' }
const Inter: FontRef = { css: 'Inter', pptx: 'Inter', embed: 'Inter' }
const DMSerif: FontRef = { css: 'DM Serif Display', pptx: 'DM Serif Display', embed: 'DMSerifDisplay', serif: true }
const DMSans: FontRef = { css: 'DM Sans', pptx: 'DM Sans', embed: 'DMSans' }

export const EXTRA_THEMES: Theme[] = [
  {
    id: 'graphite', name: 'Graphite Executive', dark: true,
    c: {
      bg: '#131417', surface: '#1B1D21', surface2: '#24272C', text: '#F3F1EC', muted: '#A7A39B',
      accent: '#F0B24A', accent2: '#D9773A', onAccent: '#1A1408', border: '#2E3138', good: '#5CC98B', bad: '#F07A6B',
      chart: ['#F0B24A', '#6CB2EE', '#2EA37F', '#C46FB0', '#E6E1D6'],
    },
    head: { ...Arial, weight: 700, tracking: -0.02 }, body: Calibri, radius: 10, decor: 'blobs',
  },
  {
    id: 'ocean', name: 'Ocean Clarity', dark: false,
    c: {
      bg: '#FFFFFF', surface: '#EFF5F9', surface2: '#E1ECF3', text: '#0B2239', muted: '#4A6074',
      accent: '#0F4C81', accent2: '#14A3A0', onAccent: '#FFFFFF', border: '#D6E3EC', good: '#0F7743', bad: '#C0392B',
      chart: ['#0F4C81', '#14A3A0', '#C2504A', '#A3405F', '#5C9E3F'],
    },
    head: { ...Arial, weight: 700, tracking: -0.02 }, body: Calibri, radius: 12, decor: 'blobs',
  },
  {
    id: 'swiss', name: 'Swiss Mono', dark: false,
    c: {
      bg: '#FFFFFF', surface: '#F3F3F3', surface2: '#E8E8E8', text: '#0A0A0A', muted: '#555555',
      accent: '#B5122B', accent2: '#1A1A1A', onAccent: '#FFFFFF', border: '#DADADA', good: '#1E7A3C', bad: '#B5122B',
      chart: ['#B5122B', '#8C8C8C', '#2B5DA8', '#5B8DD6', '#C97A12'],
    },
    head: { ...Arial, weight: 700, tracking: -0.03 }, body: Arial, radius: 2, decor: 'rings',
  },
  {
    id: 'forest', name: 'Forest Serif', dark: true,
    c: {
      bg: '#0F1D18', surface: '#152720', surface2: '#1C3129', text: '#F2EEE3', muted: '#A9B6AA',
      accent: '#CFA85E', accent2: '#B98545', onAccent: '#13201A', border: '#27392F', good: '#7CCB8F', bad: '#EA8C7B',
      chart: ['#CFA85E', '#7DBE9E', '#6EA3D8', '#D9826A', '#E6DFCE'],
    },
    head: { ...Georgia, weight: 700, tracking: -0.01 }, body: Calibri, radius: 8, decor: 'rings',
  },
  {
    id: 'sunrise', name: 'Sunrise Startup', dark: false,
    c: {
      bg: '#FFF8F1', surface: '#FFEFE3', surface2: '#FBE3D2', text: '#2A1633', muted: '#6B5264',
      accent: '#5E32C4', accent2: '#E0503A', onAccent: '#FFFFFF', border: '#F3D9C6', good: '#1A7550', bad: '#C23A2B',
      chart: ['#5E32C4', '#E0503A', '#1B9E85', '#2F7FD1', '#B07800'],
    },
    head: { ...Arial, weight: 700, tracking: -0.025 }, body: Calibri, radius: 20, decor: 'blobs',
  },
  // ---------- Premium (Phase 4): eigene Schriftpaare, eingebettet ----------
  {
    id: 'atelier', name: 'Atelier Editorial', dark: false,
    c: {
      bg: '#F6F1E8', surface: '#EDE6DA', surface2: '#E3DACB', text: '#1B1A17', muted: '#5E574D',
      accent: '#9A3B26', accent2: '#5C6B3C', onAccent: '#FFFFFF', border: '#DDD3C3', good: '#3F6B2E', bad: '#A8321F',
      chart: ['#9A3B26', '#5C6B3C', '#C08A3E', '#3E5C76', '#8C7B6B'],
    },
    head: { ...Fraunces, weight: 700, tracking: -0.015 }, body: Manrope, radius: 4, decor: 'rings', texture: 'grain',
  },
  {
    id: 'signal', name: 'Signal Tech', dark: true,
    c: {
      bg: '#0B0D12', surface: '#151922', surface2: '#1D2330', text: '#F5F7FA', muted: '#9AA3B2',
      accent: '#C6FF3D', accent2: '#7C5CFF', onAccent: '#0B0D12', border: '#262D3B', good: '#5BE38A', bad: '#FF6B6B',
      chart: ['#C6FF3D', '#7C5CFF', '#3DD6F5', '#FF8A4C', '#9AA3B2'],
    },
    head: { ...SpaceGrotesk, weight: 700, tracking: -0.03 }, body: Inter, radius: 16, decor: 'glow',
  },
  {
    id: 'noir', name: 'Noir Luxe', dark: true,
    c: {
      bg: '#111111', surface: '#1A1A1A', surface2: '#232323', text: '#F2EFE9', muted: '#A39E94',
      accent: '#C9A96E', accent2: '#8A8A8A', onAccent: '#111111', border: '#2C2C2C', good: '#9CC59A', bad: '#E0877A',
      chart: ['#C9A96E', '#E8E2D6', '#8A8A8A', '#A7865A', '#5E5E5E'],
    },
    head: { ...DMSerif, weight: 400, tracking: -0.01 }, body: DMSans, radius: 0, decor: 'stripe',
  },
]

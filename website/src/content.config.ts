// Neuigkeiten: jede Datei in src/content/neuigkeiten ist ein Artikel (Frontmatter: titel, datum, zusammenfassung)
import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

export const collections = {
  neuigkeiten: defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/neuigkeiten' }),
    schema: z.object({
      titel: z.string(),
      datum: z.coerce.date(),
      zusammenfassung: z.string(),
    }),
  }),
}

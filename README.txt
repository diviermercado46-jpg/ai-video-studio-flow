AI VIDEO STUDIO FLOW V27

V27 añade investigación web independiente sin API de búsqueda adicional:
- Google News RSS para artículos actuales.
- Wikipedia API para contexto y antecedentes.
- Las URLs recuperadas se muestran en FUENTES ENCONTRADAS.
- Las fuentes se pasan al motor IA antes de generar el guion.
- OpenRouter sigue siendo el motor gratuito principal/fallback.
- Gemini, OpenAI y Claude siguen siendo opcionales.

RENDER
Variables opcionales:
OPENROUTER_API_KEY
GEMINI_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY

No pongas claves dentro de index.html. Configúralas en Render > Environment.
Start command: node server.js
Node: >=20

AI VIDEO STUDIO FLOW V26

Qué cambia:
- AUTO selecciona el primer motor disponible.
- OpenRouter Free es el motor recomendado para empezar sin pagar: usa modelos gratuitos.
- Si un proveedor falla por cuota/error, AUTO intenta el siguiente proveedor configurado.
- Gemini mantiene búsqueda web mediante Google Search grounding cuando está disponible.
- Las API keys solo viven en Render Environment Variables; nunca en el navegador.

Render:
Build Command: npm install
Start Command: npm start
Environment recomendado:
OPENROUTER_API_KEY=tu_clave
GEMINI_API_KEY=tu_clave (opcional)
OPENAI_API_KEY=tu_clave (opcional)
ANTHROPIC_API_KEY=tu_clave (opcional)

Importante:
El nivel gratuito no es ilimitado. OpenRouter publica actualmente 50 solicitudes/día en su plan Free. Si una cuota se agota, AUTO intenta otro proveedor configurado.

No se simulan clics dentro de Google Flow. La aplicación prepara prompts y abre Flow para que el usuario continúe allí.

// Proxy for Google Places photo references.
// Returns a redirect to the Google CDN URL so the API key never leaves the server.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ref } = req.query;
  if (!ref) return res.status(400).json({ error: 'Missing ref.' });

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'Server misconfigured.' });

  try {
    // skipHttpRedirect=true returns JSON with a photoUri (public CDN URL, no key needed)
    const r = await fetch(
      `https://places.googleapis.com/v1/${ref}/media?maxHeightPx=600&maxWidthPx=600&skipHttpRedirect=true`,
      { headers: { 'X-Goog-Api-Key': API_KEY }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(404).end();
    const data = await r.json();
    if (!data.photoUri) return res.status(404).end();

    res.setHeader('Cache-Control', 'public, max-age=86400'); // cache for 24 h
    return res.redirect(302, data.photoUri);
  } catch (_) {
    return res.status(503).end();
  }
}
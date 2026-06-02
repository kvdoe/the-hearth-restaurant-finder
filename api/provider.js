export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ provider: process.env.RESTAURANT_PROVIDER || 'yelp' });
}
const SUPABASE_URL  = process.env.SUPABASE_URL  ?? 'https://mrhekpgvfcwfnzmipjis.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yaGVrcGd2ZmN3Zm56bWlwamlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxMzQxMTQsImV4cCI6MjA5NTcxMDExNH0.mopznBoOZAhTeir31cJXlqnUPhIO9tk9eD4W5m1j_w4';

export async function supabaseFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const { headers: extraHeaders, ...rest } = options;
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...rest,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(extraHeaders as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

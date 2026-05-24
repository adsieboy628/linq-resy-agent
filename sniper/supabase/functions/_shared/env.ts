function req(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  supabaseUrl: req('SUPABASE_URL'),
  supabaseServiceKey: req('SUPABASE_SERVICE_ROLE_KEY'),
  anthropicApiKey: req('ANTHROPIC_API_KEY'),
  credentialEncryptionKey: req('SNIPER_ENCRYPTION_KEY'),
  linqApiToken: req('LINQ_API_TOKEN'),
  linqBotNumbers: req('LINQ_BOT_NUMBERS').split(',').map(s => s.trim()).filter(Boolean),
  resyApiKey: Deno.env.get('RESY_API_KEY') || 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5',
  ownerHandles: req('SNIPER_OWNER_HANDLES').split(',').map(s => s.trim()).filter(Boolean),
  webhookSecret: req('SNIPER_WEBHOOK_SECRET'),
};
